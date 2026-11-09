package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	core "github.com/abjelosevic88/pocket-homelab-core/sdk"
	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/imaging"
	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/store"
)

// ---- AI that can look at pictures ----
//
// Pocket AI takes pictures with a prompt (an "images" list next to the
// prompt, Pocket AI 0.87 and newer); an OpenAI-compatible API takes them
// as image parts of the message. Text-only questions go through the
// shared ai.Client.

type aiImage struct {
	Mime string `json:"mime"`
	Data []byte `json:"-"`
}

// aiAsk runs one question, with pictures when there are any, and decodes
// the JSON answer into v.
func (s *Server) aiAsk(ctx context.Context, uid int64, st store.Settings, system, prompt string, images []aiImage, v any) error {
	cl, used, why := s.aiFor(ctx, uid, st)
	if cl == nil {
		return &userErr{firstNonEmpty(why, "AI is not set up (Settings → AI)")}
	}
	if len(images) == 0 {
		return cl.JSON(ctx, system, prompt, v)
	}
	if !st.AIPhotos {
		return &userErr{"sending photos to the AI is switched off (Settings → AI)"}
	}
	var text string
	var err error
	if used == "pocket" {
		text, err = s.pocketVision(ctx, uid, st, system, prompt, images)
	} else {
		text, err = s.openaiVision(ctx, st, system, prompt, images)
	}
	if err != nil {
		return err
	}
	text = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(text), "```json"), "```"), "```"))
	if i := strings.IndexByte(text, '{'); i > 0 {
		text = text[i:]
	}
	if err := json.Unmarshal([]byte(text), v); err != nil {
		return fmt.Errorf("the AI's answer was not valid JSON: %w", err)
	}
	return nil
}

type pocketImage struct {
	Mime string `json:"mime"`
	Data string `json:"data"` // base64
}

func (s *Server) pocketVision(ctx context.Context, uid int64, st store.Settings, system, prompt string, images []aiImage) (string, error) {
	u, err := s.store.GetUser(ctx, uid)
	if err != nil {
		return "", err
	}
	tok, err := s.core.ActAs(ctx, u.Email, "ai", core.InferenceScope)
	if err != nil {
		return "", fmt.Errorf("Pocket AI: %w", err)
	}
	body := map[string]any{"system": system, "prompt": prompt, "json": true}
	if st.AIPocketModel != "" {
		body["model"] = st.AIPocketModel
	}
	var imgs []pocketImage
	for _, im := range images {
		imgs = append(imgs, pocketImage{Mime: im.Mime, Data: base64.StdEncoding.EncodeToString(im.Data)})
	}
	body["images"] = imgs
	raw, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(ctx, 170*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(tok.URL, "/")+"/api/v1/inference", bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 170 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("Pocket AI: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&e)
		if res.StatusCode == http.StatusBadRequest && strings.Contains(e.Error, "provide a prompt") {
			return "", &userErr{"this Pocket AI cannot look at photos yet: update Pocket AI, or use your own OpenAI key for photos (Settings → AI)"}
		}
		return "", fmt.Errorf("Pocket AI HTTP %d: %s", res.StatusCode, e.Error)
	}
	var out core.InferenceReply
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&out); err != nil {
		return "", err
	}
	if strings.TrimSpace(out.Text) == "" {
		return "", errors.New("Pocket AI returned no answer")
	}
	return out.Text, nil
}

func (s *Server) openaiVision(ctx context.Context, st store.Settings, system, prompt string, images []aiImage) (string, error) {
	base := strings.TrimRight(firstNonEmpty(st.OpenAIBaseURL, "https://api.openai.com/v1"), "/")
	model := firstNonEmpty(st.OpenAIModel, "gpt-4o-mini")
	parts := []map[string]any{{"type": "text", "text": prompt}}
	for _, im := range images {
		parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:" + im.Mime + ";base64," + base64.StdEncoding.EncodeToString(im.Data), "detail": "low"}})
	}
	body := map[string]any{"model": model, "response_format": map[string]string{"type": "json_object"},
		"messages": []map[string]any{{"role": "system", "content": system}, {"role": "user", "content": parts}}}
	raw, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(ctx, 150*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/chat/completions", bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+st.OpenAIKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := (&http.Client{Timeout: 150 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(b, &e)
		return "", fmt.Errorf("AI HTTP %d: %s", res.StatusCode, e.Error.Message)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(b, &out); err != nil || len(out.Choices) == 0 {
		return "", errors.New("the AI returned no answer")
	}
	return out.Choices[0].Message.Content, nil
}

// ---- what the lab asks the AI ----

const aiLabVoice = `You are a careful photo editor looking at one picture. You answer only in JSON, in plain everyday words, never inventing what is not in the picture.`

// labAdjust are the sliders the AI may set (web/src/lib/recipe.ts names; -100…100 unless noted).
var labAdjust = []string{"exposure", "contrast", "highlights", "shadows", "whites", "blacks", "temperature", "tint", "vibrance", "saturation", "clarity", "dehaze", "sharpen", "vignette", "fade", "grain"}

// aiPicture reads the picture the editor sent (a small JPEG data URL).
func aiPicture(v string) ([]aiImage, error) {
	b, err := decodeDataURL(v, 4<<20)
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return nil, &userErr{"no picture sent"}
	}
	return []aiImage{{Mime: imagingSniff(b), Data: b}}, nil
}

// handleAISuggest asks the AI for an edit: slider values and, if it fits, a
// crop or straightening, with a sentence on why.
func (s *Server) handleAISuggest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	st, _ := s.store.GetSettings(ctx, uid)
	var in struct {
		Image string `json:"image"`
		Wish  string `json:"wish"` // "warmer", "for Instagram", "make it pop" …
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	imgs, err := aiPicture(in.Image)
	if err != nil {
		s.failUser(w, err, "ai")
		return
	}
	wish := strings.TrimSpace(in.Wish)
	if wish == "" {
		wish = "a natural, balanced improvement: correct exposure and white balance, recover highlights and shadows, a little more life in the colours, nothing overdone"
	}
	prompt := "Suggest an edit for this photo. What the person wants: " + clip(wish, 300) + ".\n" +
		"Answer as JSON: {\"adjust\": {" + strings.Join(labAdjust, ", ") + " — only the ones to change, whole numbers from -100 to 100 (sharpen, vignette, fade, grain, clarity, dehaze 0 to 100; vignette darkens edges when positive)}, " +
		"\"look\": one of none, vivid, warm, cool, film, fade, matte, mono, noir, sepia, chrome, vintage, golden, teal-orange, pastel, dramatic (or none), \"look_strength\": 0–100, " +
		"\"straighten\": degrees from -10 to 10 if the horizon is tilted (else 0), \"crop\": null or {\"aspect\": \"free|1:1|4:5|3:2|16:9\", \"x\": 0–1, \"y\": 0–1, \"w\": 0–1, \"h\": 0–1} only if a tighter frame clearly helps, " +
		"\"why\": one or two short sentences on what you changed and why}."
	var out struct {
		Adjust       map[string]float64 `json:"adjust"`
		Look         string             `json:"look"`
		LookStrength float64            `json:"look_strength"`
		Straighten   float64            `json:"straighten"`
		Why          string             `json:"why"`
	}
	var raw map[string]any
	if err := s.aiAsk(ctx, uid, st, aiLabVoice, prompt, imgs, &raw); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	b, _ := json.Marshal(raw)
	_ = json.Unmarshal(b, &out)
	adjust := map[string]float64{}
	for _, k := range labAdjust {
		if v, ok := out.Adjust[k]; ok {
			lo := -100.0
			switch k {
			case "sharpen", "fade", "grain", "clarity", "dehaze":
				lo = 0
			}
			adjust[k] = math.Round(math.Max(lo, math.Min(100, v)))
		}
	}
	res := map[string]any{"ok": true, "adjust": adjust, "look": out.Look, "look_strength": math.Max(0, math.Min(100, out.LookStrength)),
		"straighten": math.Max(-10, math.Min(10, out.Straighten)), "why": strings.TrimSpace(out.Why)}
	if c, ok := raw["crop"].(map[string]any); ok {
		num := func(k string) float64 { v, _ := c[k].(float64); return math.Max(0, math.Min(1, v)) }
		x, y, cw, ch := num("x"), num("y"), num("w"), num("h")
		if cw > 0.2 && ch > 0.2 && x+cw <= 1.001 && y+ch <= 1.001 {
			res["crop"] = map[string]any{"x": x, "y": y, "w": cw, "h": ch, "aspect": c["aspect"]}
		}
	}
	writeJSON(w, http.StatusOK, res)
}

// handleAIDescribe gives a picture a title, a description for people who
// can't see it (alt text) and a few tags.
func (s *Server) handleAIDescribe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	st, _ := s.store.GetSettings(ctx, uid)
	var in struct {
		Image string `json:"image"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	imgs, err := aiPicture(in.Image)
	if err != nil {
		s.failUser(w, err, "ai")
		return
	}
	var out struct {
		Title string   `json:"title"`
		Alt   string   `json:"alt"`
		Tags  []string `json:"tags"`
	}
	prompt := `Describe this photo. Answer as JSON: {"title": a short title (2–6 words, no quotes), "alt": one or two sentences describing it for someone who can't see it, "tags": up to six lowercase words}.`
	if err := s.aiAsk(ctx, uid, st, aiLabVoice, prompt, imgs, &out); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if out.Tags == nil {
		out.Tags = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "title": clip(strings.TrimSpace(out.Title), 120), "alt": clip(strings.TrimSpace(out.Alt), 600), "tags": out.Tags})
}

func imagingSniff(b []byte) string {
	if m := imaging.Sniff(b); m != "" {
		return m
	}
	return "image/jpeg"
}
