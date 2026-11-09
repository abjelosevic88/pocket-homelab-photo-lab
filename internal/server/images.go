package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/imaging"
	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/store"
)

// ---- pictures in the lab ----
//
// The original is written once to IMAGES_DIR/<user>/ and never changed. The
// edit is a recipe (JSON) the browser applies; when it saves, the browser also
// sends the rendered look (a JPEG of at most 2048 px), which becomes the
// preview other apps see and the source of the library thumbnail.

const (
	thumbEdge   = 512
	previewEdge = 2048
	maxRecipe   = 2 << 20
)

// userErr is a problem the person can fix; it goes back as a 400 with the text.
type userErr struct{ msg string }

func (e *userErr) Error() string { return e.msg }

func (s *Server) failUser(w http.ResponseWriter, err error, context string) {
	var ue *userErr
	if errors.As(err, &ue) {
		writeErr(w, http.StatusBadRequest, ue.msg)
		return
	}
	if isNotConnected(err) {
		writeErr(w, http.StatusConflict, err.Error())
		return
	}
	s.fail(w, err, context)
}

func randomName() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// writeFile stores bytes under IMAGES_DIR and returns the relative path.
func (s *Server) writeFile(uid int64, sub, ext string, data []byte) (string, error) {
	rel := path.Join(fmt.Sprint(uid), sub, randomName()+ext)
	full := filepath.Join(s.cfg.ImagesDir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return "", err
	}
	tmp := full + ".part"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return "", err
	}
	return rel, os.Rename(tmp, full)
}

func (s *Server) filePath(rel string) string {
	return filepath.Join(s.cfg.ImagesDir, filepath.FromSlash(path.Clean("/"+rel)))
}

// removeFile deletes a stored file nothing points at any more.
func (s *Server) removeFile(ctx context.Context, rel string) {
	if rel == "" || s.store.FileUsers(ctx, rel) > 0 {
		return
	}
	_ = os.Remove(s.filePath(rel))
}

// newImage is a picture arriving in the lab.
type newImage struct {
	data      []byte
	name      string // the file name it came with
	title     string
	source    string
	sourceRef string
	takenAt   string
	thumb     []byte // from the browser, for pictures the server can't read
	note      string
	camera    string
}

// addImage stores a picture (or finds the one already there) for person uid.
// The second value is false when it was already in the lab.
func (s *Server) addImage(ctx context.Context, uid int64, in newImage) (*store.Image, bool, error) {
	if len(in.data) == 0 {
		return nil, false, &userErr{"the file is empty"}
	}
	if int64(len(in.data)) > s.cfg.MaxUploadBytes {
		return nil, false, &userErr{fmt.Sprintf("the picture is larger than %d MB", s.cfg.MaxUploadBytes>>20)}
	}
	if imaging.IsRaw(in.name) {
		// a camera RAW: the full-size JPEG the camera put inside it
		prev, err := imaging.RawPreview(in.data)
		if err != nil {
			return nil, false, &userErr{"this RAW file has no picture inside that the lab can open"}
		}
		cam := ""
		if inf, err := imaging.Probe(prev); err == nil {
			cam = inf.Camera
		}
		if in.note == "" {
			in.note = "From the camera's own full-size JPEG inside " + path.Base(in.name)
		}
		in.data, in.camera = prev, firstNonEmpty(in.camera, cam)
	}
	info, err := imaging.Probe(in.data)
	if err != nil {
		return nil, false, &userErr{imaging.ErrUnsupported.Error()}
	}
	sum := sha256.Sum256(in.data)
	sha := hex.EncodeToString(sum[:])
	if old, err := s.store.FindImage(ctx, uid, in.source, in.sourceRef, sha); err == nil {
		return old, false, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, false, err
	}
	data, mime := in.data, info.Mime
	var thumb []byte
	if info.Decodable {
		img, err := imaging.Decode(data)
		if err != nil {
			return nil, false, &userErr{imaging.ErrUnsupported.Error()}
		}
		if mime == "image/tiff" {
			// browsers can't open TIFF: keep the pixels as PNG
			if data, err = imaging.PNG(img); err != nil {
				return nil, false, err
			}
			mime = "image/png"
		}
		thumb, _ = imaging.Thumb(img, thumbEdge, 82)
	} else if len(in.thumb) > 0 {
		thumb = in.thumb
	}
	rel, err := s.writeFile(uid, time.Now().Format("2006"), imaging.Ext(mime), data)
	if err != nil {
		return nil, false, err
	}
	title := strings.TrimSpace(in.title)
	if title == "" {
		title = titleFromName(in.name)
	}
	taken := in.takenAt
	if taken == "" {
		taken = info.TakenAt
	}
	im := &store.Image{Title: clip(title, 200), File: rel, Mime: mime, Width: info.Width, Height: info.Height, Bytes: int64(len(data)), SHA256: sha,
		Source: firstNonEmpty(in.source, "upload"), SourceRef: in.sourceRef, SourceName: clip(in.name, 255), TakenAt: taken, Note: clip(in.note, 2000),
		Camera: clip(firstNonEmpty(in.camera, info.Camera), 120)}
	if len(thumb) == 0 {
		im.Stale = true // HEIC and friends: the next browser that opens the lab draws the thumbnail
	}
	if err := s.store.CreateImage(ctx, uid, im, thumb); err != nil {
		_ = os.Remove(s.filePath(rel))
		return nil, false, err
	}
	s.publish(ctx, uid, "photolab.image_added", fmt.Sprintf("image:%d", im.ID), map[string]any{"image_id": im.ID, "title": im.Title, "source": im.Source, "width": im.Width, "height": im.Height})
	return im, true, nil
}

func titleFromName(name string) string {
	base := strings.TrimSuffix(path.Base(strings.ReplaceAll(name, "\\", "/")), path.Ext(name))
	base = strings.TrimSpace(strings.NewReplacer("_", " ", "-", " ").Replace(base))
	if base == "" || base == "." || base == "/" {
		return "Untitled"
	}
	return base
}

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n])
}

// decodeDataURL reads a small picture sent as a data: URL or bare base64.
func decodeDataURL(v string, max int) ([]byte, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil, nil
	}
	if i := strings.Index(v, ","); strings.HasPrefix(v, "data:") && i > 0 {
		v = v[i+1:]
	}
	b, err := base64.StdEncoding.DecodeString(v)
	if err != nil {
		return nil, &userErr{"the thumbnail is not valid base64"}
	}
	if len(b) > max {
		return nil, &userErr{"the thumbnail is too large"}
	}
	switch imaging.Sniff(b) {
	case "image/jpeg", "image/png", "image/webp":
		return b, nil
	}
	return nil, &userErr{"the thumbnail must be JPEG, PNG or WebP"}
}

// ---- handlers ----

func (s *Server) handleListImages(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	q := r.URL.Query()
	sort := q.Get("sort")
	if sort == "" {
		st, _ := s.store.GetSettings(ctx, uid)
		sort = st.Sort
	}
	items, total, err := s.store.ListImages(ctx, uid, store.ImageFilter{Q: q.Get("q"), Show: q.Get("show"), Sort: sort, Limit: queryInt(r, "limit"), Offset: queryInt(r, "offset")})
	if err != nil {
		s.fail(w, err, "images")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total})
}

// handleUpload takes one or more pictures (multipart "file"), each with an
// optional browser-made "thumb" (for kinds the server can't read). A Pocket
// app on a link may send pictures too; they are marked as coming from it.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+(8<<20))
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "send the pictures as multipart form data (field \"file\"), each up to "+fmt.Sprint(s.cfg.MaxUploadBytes>>20)+" MB")
		return
	}
	defer r.MultipartForm.RemoveAll()
	files := r.MultipartForm.File["file"]
	if len(files) == 0 {
		writeErr(w, http.StatusBadRequest, "no picture sent (field \"file\")")
		return
	}
	var thumb []byte
	if t := r.FormValue("thumb"); t != "" {
		var err error
		if thumb, err = decodeDataURL(t, 1<<20); err != nil {
			s.failUser(w, err, "upload")
			return
		}
	}
	source, ref := "upload", strings.TrimSpace(r.FormValue("source_ref"))
	if r.FormValue("source") == "collage" {
		source = "collage"
	}
	if app := linkApp(ctx); app != "" {
		source = app
	}
	added, already := []store.Image{}, []store.Image{}
	skipped := []map[string]string{}
	for _, fh := range files {
		f, err := fh.Open()
		if err != nil {
			skipped = append(skipped, map[string]string{"name": fh.Filename, "error": err.Error()})
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, s.cfg.MaxUploadBytes+1))
		f.Close()
		if err != nil {
			skipped = append(skipped, map[string]string{"name": fh.Filename, "error": err.Error()})
			continue
		}
		in := newImage{data: data, name: fh.Filename, source: source, sourceRef: ref, note: r.FormValue("note"), takenAt: r.FormValue("taken_at")}
		if len(files) == 1 {
			in.title, in.thumb = r.FormValue("title"), thumb
		}
		im, fresh, err := s.addImage(ctx, uid, in)
		if err != nil {
			var ue *userErr
			if errors.As(err, &ue) {
				skipped = append(skipped, map[string]string{"name": fh.Filename, "error": ue.msg})
				continue
			}
			s.fail(w, err, "upload")
			return
		}
		if fresh {
			added = append(added, *im)
		} else {
			already = append(already, *im)
		}
	}
	code := http.StatusCreated
	if len(added) == 0 && len(already) == 0 {
		code = http.StatusBadRequest
	}
	out := map[string]any{"items": added, "already": already, "skipped": skipped}
	if len(added)+len(already) == 1 {
		im := append(added, already...)[0]
		out["id"], out["url"] = im.ID, s.itemURL(im.ID)
	}
	if code == http.StatusBadRequest && len(skipped) > 0 {
		out["error"] = skipped[0]["error"]
	}
	writeJSON(w, code, out)
}

// itemURL opens a picture in the editor.
func (s *Server) itemURL(id int64) string {
	return s.cfg.BaseURL + fmt.Sprintf("/edit/%d", id)
}

func (s *Server) handleGetImage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	im, err := s.store.GetImage(ctx, actorID(ctx), idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "image")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"image": im, "item_url": s.itemURL(im.ID)})
}

// mayChange: a Pocket app on a link changes only the pictures it sent.
func mayChange(ctx context.Context, im *store.Image) bool {
	app := linkApp(ctx)
	return app == "" || im.Source == app
}

func (s *Server) handleUpdateImage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	im, err := s.store.GetImage(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "image")
		return
	}
	if !mayChange(ctx, im) {
		writeErr(w, http.StatusForbidden, "this picture was not sent by "+linkApp(ctx))
		return
	}
	var in struct {
		Title    string          `json:"title"`
		Note     string          `json:"note"`
		Favorite bool            `json:"favorite"`
		Recipe   json.RawMessage `json:"recipe"`
		Edited   bool            `json:"edited"`
	}
	keys, err := decodeKeys(r, &in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if keys["title"] {
		im.Title = clip(strings.TrimSpace(in.Title), 200)
		if im.Title == "" {
			im.Title = "Untitled"
		}
	}
	if keys["note"] {
		im.Note = clip(strings.TrimSpace(in.Note), 2000)
	}
	if keys["favorite"] {
		im.Favorite = in.Favorite
	}
	edited := false
	if keys["recipe"] {
		if len(in.Recipe) > maxRecipe || !json.Valid(in.Recipe) || !bytes.HasPrefix(bytes.TrimSpace(in.Recipe), []byte("{")) {
			writeErr(w, http.StatusBadRequest, "the edit must be a JSON object")
			return
		}
		im.Recipe = in.Recipe
		im.Edited = in.Edited
		if !keys["edited"] {
			im.Edited = !bytes.Equal(bytes.TrimSpace(in.Recipe), []byte("{}"))
		}
		im.EditedAt = store.Now()
		edited = true
	}
	if err := s.store.UpdateImage(ctx, uid, im); err != nil {
		s.fail(w, err, "save")
		return
	}
	if edited {
		s.publish(ctx, uid, "photolab.image_edited", fmt.Sprintf("image:%d", im.ID), map[string]any{"image_id": im.ID, "title": im.Title, "edited": im.Edited})
	}
	writeJSON(w, http.StatusOK, map[string]any{"image": im})
}

func (s *Server) handleDeleteImage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	im, err := s.store.GetImage(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "image")
		return
	}
	if !mayChange(ctx, im) {
		writeErr(w, http.StatusForbidden, "this picture was not sent by "+linkApp(ctx))
		return
	}
	if _, err := s.store.DeleteImage(ctx, uid, im.ID); err != nil {
		s.fail(w, err, "delete")
		return
	}
	s.removeFile(ctx, im.File)
	s.removeFile(ctx, im.Preview)
	w.WriteHeader(http.StatusNoContent)
}

// handleCopyImage makes a second picture from the same original, with the
// same edit to go on from (or none).
func (s *Server) handleCopyImage(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	im, err := s.store.GetImage(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "image")
		return
	}
	var in struct {
		Fresh bool `json:"fresh"` // start from the original
	}
	_ = decode(r, &in)
	thumb, _, _ := s.store.ImageThumb(ctx, uid, im.ID)
	cp := *im
	cp.Title = clip(im.Title+" (copy)", 200)
	cp.Source, cp.SourceRef, cp.Favorite, cp.Preview = "copy", fmt.Sprint(im.ID), false, ""
	if in.Fresh {
		cp.Recipe, cp.Edited, cp.EditedAt = json.RawMessage(`{}`), false, ""
		if data, err := os.ReadFile(s.filePath(im.File)); err == nil {
			if img, err := imaging.Decode(data); err == nil {
				thumb, _ = imaging.Thumb(img, thumbEdge, 82)
			}
		}
	} else if im.Preview != "" {
		if data, err := os.ReadFile(s.filePath(im.Preview)); err == nil {
			if rel, err := s.writeFile(uid, "looks", ".jpg", data); err == nil {
				cp.Preview = rel
			}
		}
	}
	if err := s.store.CreateImage(ctx, uid, &cp, thumb); err != nil {
		s.fail(w, err, "copy")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"image": cp, "item_url": s.itemURL(cp.ID)})
}

// serveStored sends a stored file; with ?v= (the picture's updated_at) the
// browser may keep it.
func (s *Server) serveStored(w http.ResponseWriter, r *http.Request, rel, mime, name string) {
	f, err := os.Open(s.filePath(rel))
	if err != nil {
		writeErr(w, http.StatusNotFound, "the file is missing")
		return
	}
	defer f.Close()
	fi, _ := f.Stat()
	w.Header().Set("Content-Type", mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	if r.URL.Query().Get("v") != "" {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "private, no-cache")
	}
	if name != "" && queryBool(r, "download") {
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	}
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

func (s *Server) handleOriginal(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	im, err := s.store.GetImage(ctx, actorID(ctx), idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "image")
		return
	}
	name := im.SourceName
	if name == "" || path.Ext(name) != imaging.Ext(im.Mime) {
		name = im.Title + imaging.Ext(im.Mime)
	}
	s.serveStored(w, r, im.File, im.Mime, name)
}

// handlePreview is the current look (the original until something was saved).
func (s *Server) handlePreview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	im, err := s.store.GetImage(ctx, actorID(ctx), idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "image")
		return
	}
	if im.Preview == "" {
		s.serveStored(w, r, im.File, im.Mime, "")
		return
	}
	s.serveStored(w, r, im.Preview, "image/jpeg", im.Title+".jpg")
}

func serveBytes(w http.ResponseWriter, r *http.Request, b []byte) {
	w.Header().Set("Content-Type", imaging.Sniff(b))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.URL.Query().Get("v") != "" {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "private, no-cache")
	}
	_, _ = w.Write(b)
}

func (s *Server) handleThumb(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	b, _, err := s.store.ImageThumb(ctx, actorID(ctx), idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "thumb")
		return
	}
	if len(b) == 0 {
		writeErr(w, http.StatusNotFound, "no thumbnail")
		return
	}
	serveBytes(w, r, b)
}

// handleSaveLook stores the rendered current look the editor sends (a JPEG,
// raw body or multipart "file") as the preview, and makes the thumbnail.
func (s *Server) handleSaveLook(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	im, err := s.store.GetImage(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "image")
		return
	}
	data, err := readPicture(w, r, 32<<20)
	if err != nil {
		s.failUser(w, err, "look")
		return
	}
	var preview string
	var thumb []byte
	if !queryBool(r, "reset") {
		img, err := imaging.Decode(data)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "the look must be a JPEG, PNG or WebP picture")
			return
		}
		if b := img.Bounds(); b.Dx() > previewEdge || b.Dy() > previewEdge {
			img = imaging.Fit(img, previewEdge)
			if data, err = imaging.Thumb(img, previewEdge, 90); err != nil {
				s.fail(w, err, "look")
				return
			}
		}
		if preview, err = s.writeFile(uid, "looks", imaging.Ext(imaging.Sniff(data)), data); err != nil {
			s.fail(w, err, "look")
			return
		}
		thumb, _ = imaging.Thumb(img, thumbEdge, 82)
	} else if orig, err := os.ReadFile(s.filePath(im.File)); err == nil {
		if img, err := imaging.Decode(orig); err == nil {
			thumb, _ = imaging.Thumb(img, thumbEdge, 82)
		}
	}
	if err := s.store.SetImageLook(ctx, uid, im.ID, preview, thumb); err != nil {
		s.fail(w, err, "look")
		return
	}
	s.removeFile(ctx, im.Preview)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "has_preview": preview != ""})
}

// readPicture takes a picture from a raw body or the multipart "file" field.
func readPicture(w http.ResponseWriter, r *http.Request, max int64) ([]byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, max)
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
		f, _, err := r.FormFile("file")
		if err != nil {
			return nil, &userErr{"no picture sent (field \"file\")"}
		}
		defer f.Close()
		return io.ReadAll(f)
	}
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, &userErr{"the picture is too large"}
	}
	return b, nil
}

// ---- versions ----

func (s *Server) handleListVersions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	if _, err := s.store.GetImage(ctx, uid, idParam(r, "id")); err != nil {
		s.fail(w, err, "image")
		return
	}
	vs, err := s.store.ListVersions(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "versions")
		return
	}
	writeJSON(w, http.StatusOK, vs)
}

func (s *Server) handleCreateVersion(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var in struct {
		Name   string          `json:"name"`
		Recipe json.RawMessage `json:"recipe"`
		Thumb  string          `json:"thumb"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(in.Recipe) == 0 || len(in.Recipe) > maxRecipe || !json.Valid(in.Recipe) {
		writeErr(w, http.StatusBadRequest, "the edit must be a JSON object")
		return
	}
	thumb, err := decodeDataURL(in.Thumb, 512<<10)
	if err != nil {
		s.failUser(w, err, "version")
		return
	}
	v := &store.Version{ImageID: idParam(r, "id"), Name: clip(firstNonEmpty(strings.TrimSpace(in.Name), time.Now().Format("2 Jan 15:04")), 120), Recipe: in.Recipe}
	if err := s.store.CreateVersion(ctx, actorID(ctx), v, thumb); err != nil {
		s.fail(w, err, "version")
		return
	}
	writeJSON(w, http.StatusCreated, v)
}

func (s *Server) handleVersionThumb(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	b, err := s.store.VersionThumb(ctx, actorID(ctx), idParam(r, "vid"))
	if err != nil || len(b) == 0 {
		writeErr(w, http.StatusNotFound, "no thumbnail")
		return
	}
	serveBytes(w, r, b)
}

func (s *Server) handleDeleteVersion(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if err := s.store.DeleteVersion(ctx, actorID(ctx), idParam(r, "vid")); err != nil {
		s.fail(w, err, "version")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- presets (looks of one's own) ----

type presetIn struct {
	Name   string          `json:"name"`
	Recipe json.RawMessage `json:"recipe"`
	Thumb  string          `json:"thumb"`
	Sort   int             `json:"sort"`
}

func (s *Server) handleListPresets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ps, err := s.store.ListPresets(ctx, actorID(ctx))
	if err != nil {
		s.fail(w, err, "presets")
		return
	}
	writeJSON(w, http.StatusOK, ps)
}

func (s *Server) handleCreatePreset(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var in presetIn
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	in.Name = clip(strings.TrimSpace(in.Name), 80)
	if in.Name == "" {
		writeErr(w, http.StatusBadRequest, "give the look a name")
		return
	}
	if len(in.Recipe) == 0 || len(in.Recipe) > 256<<10 || !json.Valid(in.Recipe) {
		writeErr(w, http.StatusBadRequest, "the look must be a JSON object")
		return
	}
	thumb, err := decodeDataURL(in.Thumb, 512<<10)
	if err != nil {
		s.failUser(w, err, "preset")
		return
	}
	p := &store.Preset{Name: in.Name, Recipe: in.Recipe, Sort: in.Sort}
	if err := s.store.CreatePreset(ctx, actorID(ctx), p, thumb); err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeErr(w, http.StatusConflict, "you already have a look called "+in.Name)
			return
		}
		s.fail(w, err, "preset")
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) handleUpdatePreset(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	p, err := s.store.GetPreset(ctx, uid, idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "preset")
		return
	}
	var in presetIn
	keys, err := decodeKeys(r, &in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if keys["name"] {
		if p.Name = clip(strings.TrimSpace(in.Name), 80); p.Name == "" {
			writeErr(w, http.StatusBadRequest, "give the look a name")
			return
		}
	}
	if keys["recipe"] {
		if len(in.Recipe) > 256<<10 || !json.Valid(in.Recipe) {
			writeErr(w, http.StatusBadRequest, "the look must be a JSON object")
			return
		}
		p.Recipe = in.Recipe
	}
	if keys["sort"] {
		p.Sort = in.Sort
	}
	var thumb []byte
	if keys["thumb"] {
		if thumb, err = decodeDataURL(in.Thumb, 512<<10); err != nil {
			s.failUser(w, err, "preset")
			return
		}
	}
	if err := s.store.UpdatePreset(ctx, uid, p, thumb); err != nil {
		if errors.Is(err, store.ErrConflict) {
			writeErr(w, http.StatusConflict, "you already have a look called "+p.Name)
			return
		}
		s.fail(w, err, "preset")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handlePresetThumb(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	b, err := s.store.PresetThumb(ctx, actorID(ctx), idParam(r, "id"))
	if err != nil || len(b) == 0 {
		writeErr(w, http.StatusNotFound, "no thumbnail")
		return
	}
	serveBytes(w, r, b)
}

func (s *Server) handleDeletePreset(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if err := s.store.DeletePreset(ctx, actorID(ctx), idParam(r, "id")); err != nil {
		s.fail(w, err, "preset")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- the home page ----

func (s *Server) handleHome(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	recent, _, err := s.store.ListImages(ctx, uid, store.ImageFilter{Sort: "recent", Limit: 12})
	if err != nil {
		s.fail(w, err, "home")
		return
	}
	exports, _ := s.store.ListExports(ctx, uid, 8)
	writeJSON(w, http.StatusOK, map[string]any{"stats": s.store.StatsFor(ctx, uid), "recent": recent, "exports": exports})
}

// handleShare takes pictures shared to the installed app (Web Share Target)
// and opens the editor (one picture) or the library (several).
func (s *Server) handleShare(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes*4)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		http.Redirect(w, r, "/?shared=error", http.StatusSeeOther)
		return
	}
	defer r.MultipartForm.RemoveAll()
	var last int64
	n := 0
	for _, fh := range r.MultipartForm.File["file"] {
		f, err := fh.Open()
		if err != nil {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, s.cfg.MaxUploadBytes+1))
		f.Close()
		if err != nil {
			continue
		}
		if im, _, err := s.addImage(ctx, uid, newImage{data: data, name: fh.Filename, source: "upload"}); err == nil {
			last = im.ID
			n++
		}
	}
	switch {
	case n == 1:
		http.Redirect(w, r, fmt.Sprintf("/edit/%d", last), http.StatusSeeOther)
	case n > 1:
		http.Redirect(w, r, "/", http.StatusSeeOther)
	default:
		http.Redirect(w, r, "/?shared=error", http.StatusSeeOther)
	}
}
