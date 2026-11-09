package server

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"

	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/store"
)

// ---- changing an edit on the server (Pocket AI, scripts) ----
//
// The browser applies edits; an assistant only says what to change. This
// merges the change into each picture's recipe and marks its look stale: the
// next time Photo Lab is open in a browser, the library renders the new look.

// builtinLooks are the look names web/src/lib/recipe.ts knows.
var builtinLooks = map[string]bool{"vivid": true, "warm": true, "cool": true, "golden": true, "teal-orange": true, "film": true, "fade": true, "matte": true, "pastel": true, "chrome": true,
	"dramatic": true, "vintage": true, "lomo": true, "summer": true, "winter": true, "night": true, "mono": true, "noir": true, "silver": true, "sepia": true}

var adjustRange = map[string][2]float64{"exposure": {-100, 100}, "brightness": {-100, 100}, "contrast": {-100, 100}, "highlights": {-100, 100}, "shadows": {-100, 100}, "whites": {-100, 100}, "blacks": {-100, 100},
	"temperature": {-100, 100}, "tint": {-100, 100}, "vibrance": {-100, 100}, "saturation": {-100, 100}, "hue": {-180, 180}, "clarity": {-100, 100}, "dehaze": {-100, 100},
	"sharpen": {0, 100}, "denoise": {0, 100}, "vignette": {-100, 100}, "grain": {0, 100}, "fade": {0, 100}, "blur": {0, 100}}

var aspectRatios = map[string]float64{"1:1": 1, "4:5": 0.8, "5:4": 1.25, "3:2": 1.5, "2:3": 2.0 / 3, "4:3": 4.0 / 3, "3:4": 0.75, "16:9": 16.0 / 9, "9:16": 9.0 / 16}

type applyIn struct {
	IDs        []int64            `json:"ids"`
	Look       *string            `json:"look"`     // a built-in look, "none", or the name of a look of one's own
	Strength   *float64           `json:"strength"` // 0–100 for a built-in look
	Adjust     map[string]float64 `json:"adjust"`   // sliders to set (others stay)
	Aspect     string             `json:"aspect"`   // crop to a shape, centred: 1:1, 4:5, 16:9 … or "none"
	Rotate     *int               `json:"rotate"`   // quarter turns: 90, 180, 270 (added), or 0 to reset
	Straighten *float64           `json:"straighten"`
	Mono       *bool              `json:"black_and_white"`
	Frame      *float64           `json:"frame"` // a white border, % of the short side; 0 removes the frame
	Resize     *int               `json:"long_edge"`
	Reset      bool               `json:"reset"` // start from the original first
}

func (s *Server) handleApply(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	var in applyIn
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(in.IDs) == 0 || len(in.IDs) > 100 {
		writeErr(w, http.StatusBadRequest, "ids: 1 to 100 pictures")
		return
	}
	var own *store.Preset
	if in.Look != nil && *in.Look != "" && *in.Look != "none" && !builtinLooks[*in.Look] {
		presets, _ := s.store.ListPresets(ctx, uid)
		for i := range presets {
			if strings.EqualFold(presets[i].Name, *in.Look) {
				own = &presets[i]
			}
		}
		if own == nil {
			writeErr(w, http.StatusBadRequest, "no look called "+*in.Look+" (built in: "+strings.Join(sortedKeys(builtinLooks), ", ")+")")
			return
		}
	}
	for k, v := range in.Adjust {
		rg, ok := adjustRange[k]
		if !ok {
			writeErr(w, http.StatusBadRequest, "unknown slider "+k)
			return
		}
		in.Adjust[k] = math.Round(math.Max(rg[0], math.Min(rg[1], v)))
	}
	if in.Aspect != "" && in.Aspect != "none" && in.Aspect != "original" && aspectRatios[in.Aspect] == 0 {
		writeErr(w, http.StatusBadRequest, "aspect is none, original, 1:1, 4:5, 5:4, 3:2, 2:3, 4:3, 3:4, 16:9 or 9:16")
		return
	}
	changed := []store.Image{}
	for _, id := range in.IDs {
		im, err := s.store.GetImage(ctx, uid, id)
		if err != nil {
			s.fail(w, err, "image")
			return
		}
		rec := map[string]any{}
		if !in.Reset {
			_ = json.Unmarshal(im.Recipe, &rec)
		}
		rec["v"] = 1
		applyTo(rec, in, own, im)
		b, _ := json.Marshal(rec)
		im.Recipe, im.Edited, im.EditedAt, im.Stale = b, string(b) != `{"v":1}`, store.Now(), true
		if err := s.store.UpdateImage(ctx, uid, im); err != nil {
			s.fail(w, err, "save")
			return
		}
		s.publish(ctx, uid, "photolab.image_edited", fmt.Sprintf("image:%d", im.ID), map[string]any{"image_id": im.ID, "title": im.Title, "edited": im.Edited})
		changed = append(changed, *im)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": changed, "note": "The edit is saved; Photo Lab draws the new look the next time it is open in a browser."})
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func applyTo(rec map[string]any, in applyIn, own *store.Preset, im *store.Image) {
	obj := func(k string) map[string]any {
		if m, ok := rec[k].(map[string]any); ok {
			return m
		}
		m := map[string]any{}
		rec[k] = m
		return m
	}
	if own != nil {
		var p map[string]any
		_ = json.Unmarshal(own.Recipe, &p)
		for _, k := range []string{"adjust", "curves", "hsl", "split", "look", "effects"} {
			if v, ok := p[k]; ok {
				rec[k] = v
			} else {
				delete(rec, k)
			}
		}
	} else if in.Look != nil {
		if *in.Look == "" || *in.Look == "none" {
			delete(rec, "look")
		} else {
			st := 80.0
			if in.Strength != nil {
				st = math.Max(0, math.Min(100, *in.Strength))
			}
			rec["look"] = map[string]any{"name": *in.Look, "strength": st}
		}
	}
	if len(in.Adjust) > 0 {
		a := obj("adjust")
		for k, v := range in.Adjust {
			if v == 0 {
				delete(a, k)
			} else {
				a[k] = v
			}
		}
	}
	if in.Mono != nil {
		e := obj("effects")
		e["mono"] = *in.Mono
	}
	if in.Straighten != nil {
		rec["straighten"] = math.Max(-45, math.Min(45, *in.Straighten))
	}
	if in.Rotate != nil {
		cur, _ := rec["rotate"].(float64)
		n := 0
		if *in.Rotate != 0 {
			n = ((int(cur)+*in.Rotate)%360 + 360) % 360
		}
		if n != int(cur) {
			rec["rotate"] = n
			delete(rec, "crop")
			delete(rec, "resize")
		}
	}
	if in.Aspect != "" {
		delete(rec, "resize")
		if in.Aspect == "none" {
			delete(rec, "crop")
		} else {
			w, h := float64(im.Width), float64(im.Height)
			if q, _ := rec["rotate"].(float64); int(q/90)%2 == 1 {
				w, h = h, w
			}
			ratio := aspectRatios[in.Aspect]
			if in.Aspect == "original" || ratio == 0 || w == 0 || h == 0 {
				delete(rec, "crop")
			} else {
				cw, ch := 1.0, w/(ratio*h)
				if ch > 1 {
					ch, cw = 1, ratio*h/w
				}
				rec["crop"] = map[string]any{"x": (1 - cw) / 2, "y": (1 - ch) / 2, "w": cw, "h": ch, "aspect": in.Aspect}
			}
		}
	}
	if in.Frame != nil {
		if *in.Frame <= 0 {
			delete(rec, "frame")
		} else {
			rec["frame"] = map[string]any{"width": math.Min(25, *in.Frame), "color": "#ffffff", "radius": 0, "fit": "none", "fill": "color", "pad": 6}
		}
	}
	if in.Resize != nil {
		if *in.Resize <= 0 {
			delete(rec, "resize")
		} else {
			w, h := float64(im.Width), float64(im.Height)
			if q, _ := rec["rotate"].(float64); int(q/90)%2 == 1 {
				w, h = h, w
			}
			if c, ok := rec["crop"].(map[string]any); ok {
				cw, _ := c["w"].(float64)
				chh, _ := c["h"].(float64)
				if cw > 0 && chh > 0 {
					w, h = w*cw, h*chh
				}
			}
			if w > 0 && h > 0 {
				k := float64(*in.Resize) / math.Max(w, h)
				rec["resize"] = map[string]any{"w": math.Max(1, math.Round(w*k)), "h": math.Max(1, math.Round(h*k))}
			}
		}
	}
	for _, k := range []string{"adjust", "effects"} {
		if m, ok := rec[k].(map[string]any); ok && len(m) == 0 {
			delete(rec, k)
		}
	}
}

// stalePictures lists pictures whose look waits to be drawn again (for the library).
func (s *Server) handleStale(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	items, _, err := s.store.ListImages(ctx, actorID(ctx), store.ImageFilter{Show: "stale", Limit: 50})
	if err != nil {
		s.fail(w, err, "images")
		return
	}
	writeJSON(w, http.StatusOK, items)
}
