package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/imaging"
	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/pocket"
	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/store"
)

// ---- pictures from Pocket Photos and Pocket Files, and back ----
//
// Browsing and fetching go through the person's own connection (siblings.go):
// a Core link acting for them, or their URL + token. Saving back always makes
// a new photo or file; nothing in Photos or Files is ever changed.

func (s *Server) conn(ctx context.Context, a pocketApp, scopes ...string) (*siblingConn, error) {
	return s.clients(ctx, actorID(ctx)).conn(ctx, a, scopes...)
}

// handleSourceStatus says how the person reaches Photos and Files.
func (s *Server) handleSourceStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	u := userFrom(ctx)
	st, _ := s.store.GetSettings(ctx, u.ID)
	out := map[string]any{"core": s.core.Configured()}
	for _, a := range pocketApps {
		mode, via, detail := s.connStatus(ctx, u, st, a)
		out[a.slug] = map[string]any{"mode": mode, "via": via, "detail": detail, "ready": via != "", "name": a.name}
	}
	writeJSON(w, http.StatusOK, out)
}

type photoItem struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	TakenAt  string `json:"taken_at"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	Mime     string `json:"mime"`
	Favorite bool   `json:"favorite"`
	Place    string `json:"place"`
}

// handlePhotosSearch lists the person's photos (newest first) or the best
// matches for a description.
func (s *Server) handlePhotosSearch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	c, err := s.conn(ctx, appPhotos, scopePhotosRead)
	if err != nil {
		s.failUser(w, err, "photos")
		return
	}
	q := r.URL.Query()
	assets, next, err := c.client.SearchPhotos(ctx, strings.TrimSpace(q.Get("q")), q.Get("cursor"), 120, queryBool(r, "favorites"))
	if err != nil {
		writeErr(w, http.StatusBadGateway, "Pocket Photos: "+err.Error())
		return
	}
	items := make([]photoItem, 0, len(assets))
	for _, a := range assets {
		if a.Type != "" && a.Type != "IMAGE" {
			continue
		}
		it := photoItem{ID: a.ID, Name: a.OriginalFileName, TakenAt: firstNonEmpty(a.LocalDateTime, a.FileCreatedAt), Width: a.Width, Height: a.Height, Mime: a.OriginalMimeType, Favorite: a.IsFavorite}
		if a.ExifInfo != nil {
			if it.Width == 0 {
				it.Width, it.Height = a.ExifInfo.ExifImageWidth, a.ExifInfo.ExifImageHeight
			}
			it.Place = strings.Trim(a.ExifInfo.City+", "+a.ExifInfo.Country, ", ")
		}
		items = append(items, it)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "next": next, "via": c.via, "open_url": c.public})
}

func validAssetID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for i, c := range id {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !strings.ContainsRune("0123456789abcdefABCDEF", c) {
			return false
		}
	}
	return true
}

// handlePhotoThumb relays a photo's thumbnail from Pocket Photos.
func (s *Server) handlePhotoThumb(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "asset")
	if !validAssetID(id) {
		writeErr(w, http.StatusBadRequest, "not a photo id")
		return
	}
	c, err := s.conn(ctx, appPhotos, scopePhotosRead)
	if err != nil {
		s.failUser(w, err, "photos")
		return
	}
	res, err := c.client.Do(ctx, http.MethodGet, "/api/v1/immich/assets/"+id+"/thumbnail", url.Values{"size": {"thumbnail"}}, nil, "")
	if err != nil {
		writeErr(w, http.StatusBadGateway, "Pocket Photos: "+err.Error())
		return
	}
	defer res.Body.Close()
	w.Header().Set("Content-Type", firstNonEmpty(res.Header.Get("Content-Type"), "image/jpeg"))
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.Copy(w, io.LimitReader(res.Body, 8<<20))
}

// fetchPhoto downloads a photo's original, or Immich's full-size JPEG when
// browsers can't open the original (HEIC, RAW).
func (s *Server) fetchPhoto(ctx context.Context, c *siblingConn, id string) ([]byte, *pocket.Asset, error) {
	a, err := c.client.Asset(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	if a.Type != "" && a.Type != "IMAGE" {
		return nil, nil, &userErr{a.OriginalFileName + " is a video; the lab edits pictures"}
	}
	get := func(p string, q url.Values) ([]byte, error) {
		res, err := c.client.Do(ctx, http.MethodGet, p, q, nil, "")
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		return io.ReadAll(io.LimitReader(res.Body, s.cfg.MaxUploadBytes+1))
	}
	base := "/api/v1/immich/assets/" + id
	if imaging.Browser(a.OriginalMimeType) || a.OriginalMimeType == "image/tiff" || a.OriginalMimeType == "" {
		data, err := get(base+"/original", nil)
		if err == nil && imaging.Sniff(data) != "" && imaging.Sniff(data) != "image/heic" {
			return data, a, nil
		}
	}
	for _, size := range []string{"fullsize", "preview"} {
		if data, err := get(base+"/thumbnail", url.Values{"size": {size}}); err == nil && imaging.Sniff(data) != "" {
			return data, a, nil
		}
	}
	return nil, nil, &userErr{a.OriginalFileName + ": Pocket Photos sent no picture the lab can open"}
}

// handleImport brings pictures in from Pocket Photos ({"source":"photos",
// "ids":[…]}) or Pocket Files ({"source":"files","space":"home","paths":[…]}).
func (s *Server) handleImport(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	var in struct {
		Source string   `json:"source"`
		IDs    []string `json:"ids"`
		Space  string   `json:"space"`
		Paths  []string `json:"paths"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(in.IDs)+len(in.Paths) == 0 {
		writeErr(w, http.StatusBadRequest, "pick at least one picture")
		return
	}
	if len(in.IDs)+len(in.Paths) > 100 {
		writeErr(w, http.StatusBadRequest, "up to 100 pictures at a time")
		return
	}
	added, already := []store.Image{}, []store.Image{}
	skipped := []map[string]string{}
	keep := func(name string, im *store.Image, fresh bool, err error) error {
		if err != nil {
			var ue *userErr
			if errors.As(err, &ue) || errors.Is(err, pocket.ErrNotFound) {
				msg := err.Error()
				if ue != nil {
					msg = ue.msg
				}
				skipped = append(skipped, map[string]string{"name": name, "error": msg})
				return nil
			}
			return err
		}
		if fresh {
			added = append(added, *im)
		} else {
			already = append(already, *im)
		}
		return nil
	}
	switch in.Source {
	case "photos":
		c, err := s.conn(ctx, appPhotos, scopePhotosRead)
		if err != nil {
			s.failUser(w, err, "photos")
			return
		}
		for _, id := range in.IDs {
			if !validAssetID(id) {
				skipped = append(skipped, map[string]string{"name": id, "error": "not a photo id"})
				continue
			}
			if old, err := s.store.FindImage(ctx, uid, "photos", id, ""); err == nil {
				already = append(already, *old)
				continue
			}
			data, a, err := s.fetchPhoto(ctx, c, id)
			if err != nil {
				var ue *userErr
				if !errors.As(err, &ue) && !errors.Is(err, pocket.ErrNotFound) {
					err = &userErr{"Pocket Photos: " + err.Error()}
				}
				if e := keep(id, nil, false, err); e != nil {
					s.fail(w, e, "import")
					return
				}
				continue
			}
			taken := strings.TrimSuffix(firstNonEmpty(a.LocalDateTime, a.FileCreatedAt), "Z")
			if len(taken) > 19 {
				taken = taken[:19]
			}
			im, fresh, err := s.addImage(ctx, uid, newImage{data: data, name: a.OriginalFileName, source: "photos", sourceRef: id, takenAt: taken})
			if e := keep(a.OriginalFileName, im, fresh, err); e != nil {
				s.fail(w, e, "import")
				return
			}
		}
	case "files":
		c, err := s.conn(ctx, appFiles, scopeFilesRead)
		if err != nil {
			s.failUser(w, err, "files")
			return
		}
		space := firstNonEmpty(in.Space, "home")
		for _, p := range in.Paths {
			ref := space + ":" + p
			if old, err := s.store.FindImage(ctx, uid, "files", ref, ""); err == nil {
				already = append(already, *old)
				continue
			}
			res, err := c.client.Do(ctx, http.MethodGet, "/api/v1/fs/raw", url.Values{"space": {space}, "path": {p}}, nil, "")
			if err != nil {
				if e := keep(path.Base(p), nil, false, &userErr{"Pocket Files: " + err.Error()}); e != nil {
					s.fail(w, e, "import")
					return
				}
				continue
			}
			data, err := io.ReadAll(io.LimitReader(res.Body, s.cfg.MaxUploadBytes+1))
			res.Body.Close()
			if err != nil {
				s.fail(w, err, "import")
				return
			}
			im, fresh, err := s.addImage(ctx, uid, newImage{data: data, name: path.Base(p), source: "files", sourceRef: ref})
			if e := keep(path.Base(p), im, fresh, err); e != nil {
				s.fail(w, e, "import")
				return
			}
		}
	default:
		writeErr(w, http.StatusBadRequest, "source is photos or files")
		return
	}
	out := map[string]any{"items": added, "already": already, "skipped": skipped}
	if len(added)+len(already) == 1 {
		im := append(added, already...)[0]
		out["id"], out["url"] = im.ID, s.itemURL(im.ID)
	}
	writeJSON(w, http.StatusOK, out)
}

// handleFilesSpaces lists the person's places in Pocket Files.
func (s *Server) handleFilesSpaces(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	c, err := s.conn(ctx, appFiles, scopeFilesRead)
	if err != nil {
		s.failUser(w, err, "files")
		return
	}
	sp, err := c.client.Spaces(ctx)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "Pocket Files: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, sp)
}

// handleFilesList lists a folder: its folders and the pictures in it.
func (s *Server) handleFilesList(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	c, err := s.conn(ctx, appFiles, scopeFilesRead)
	if err != nil {
		s.failUser(w, err, "files")
		return
	}
	q := r.URL.Query()
	entries, err := c.client.List(ctx, firstNonEmpty(q.Get("space"), "home"), firstNonEmpty(q.Get("path"), "/"))
	if err != nil {
		writeErr(w, http.StatusBadGateway, "Pocket Files: "+err.Error())
		return
	}
	out := []pocket.Entry{}
	for _, e := range entries {
		if e.IsDir || pictureName(e.Name) {
			out = append(out, e)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": out, "open_url": c.public})
}

func pictureName(n string) bool {
	switch strings.ToLower(path.Ext(n)) {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp", ".tif", ".tiff":
		return true
	}
	return false
}

// handleFilesThumb relays a picture's thumbnail from Pocket Files.
func (s *Server) handleFilesThumb(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	c, err := s.conn(ctx, appFiles, scopeFilesRead)
	if err != nil {
		s.failUser(w, err, "files")
		return
	}
	q := r.URL.Query()
	res, err := c.client.Do(ctx, http.MethodGet, "/api/v1/fs/thumb", url.Values{"space": {firstNonEmpty(q.Get("space"), "home")}, "path": {q.Get("path")}}, nil, "")
	if err != nil {
		writeErr(w, http.StatusBadGateway, "Pocket Files: "+err.Error())
		return
	}
	defer res.Body.Close()
	w.Header().Set("Content-Type", firstNonEmpty(res.Header.Get("Content-Type"), "image/jpeg"))
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.Copy(w, io.LimitReader(res.Body, 8<<20))
}

// ---- saving a finished picture ----

var exportMimes = map[string]string{"jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp", "avif": "image/avif"}

// handleExport records a picture that left the lab and, for "photos" and
// "files", takes it there. Multipart: "file" (the finished picture) and
// "meta" (JSON: image_id, destination, name, format, width, height, space, folder).
func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	var meta struct {
		ImageID     int64  `json:"image_id"`
		Destination string `json:"destination"`
		Name        string `json:"name"`
		Format      string `json:"format"`
		Width       int    `json:"width"`
		Height      int    `json:"height"`
		Bytes       int64  `json:"bytes"`
		Space       string `json:"space"`
		Folder      string `json:"folder"`
	}
	var data []byte
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
		r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+(1<<20))
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			writeErr(w, http.StatusBadRequest, "the picture is too large")
			return
		}
		defer r.MultipartForm.RemoveAll()
		if err := json.Unmarshal([]byte(r.FormValue("meta")), &meta); err != nil {
			writeErr(w, http.StatusBadRequest, "meta must be JSON")
			return
		}
		if f, _, err := r.FormFile("file"); err == nil {
			data, _ = io.ReadAll(f)
			f.Close()
		}
	} else if err := decode(r, &meta); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	var im *store.Image
	if meta.ImageID > 0 {
		var err error
		if im, err = s.store.GetImage(ctx, uid, meta.ImageID); err != nil {
			s.fail(w, err, "export")
			return
		}
	}
	format := strings.ToLower(meta.Format)
	if format == "jpg" {
		format = "jpeg"
	}
	mime, ok := exportMimes[format]
	if !ok {
		writeErr(w, http.StatusBadRequest, "format is jpeg, png, webp or avif")
		return
	}
	name := safeName(meta.Name, format)
	e := &store.Export{Title: strings.TrimSuffix(name, path.Ext(name)), Format: format, Width: meta.Width, Height: meta.Height, Bytes: meta.Bytes, Destination: firstNonEmpty(meta.Destination, "download")}
	if im != nil {
		e.ImageID = &im.ID
		e.Title = im.Title
	}
	openURL := ""
	switch e.Destination {
	case "download":
	case "photos", "files":
		if len(data) == 0 || imaging.Sniff(data) == "" {
			writeErr(w, http.StatusBadRequest, "send the finished picture (field \"file\")")
			return
		}
		e.Bytes = int64(len(data))
		if e.Destination == "photos" {
			c, err := s.conn(ctx, appPhotos, scopePhotosWrite)
			if err != nil {
				s.failUser(w, err, "photos")
				return
			}
			created := time.Now()
			if im != nil && im.TakenAt != "" {
				if t, err := time.ParseInLocation("2006-01-02T15:04:05", im.TakenAt[:min(19, len(im.TakenAt))], time.Local); err == nil {
					created = t
				}
			}
			id, err := c.client.UploadPhoto(ctx, name, mime, data, created)
			if err != nil {
				writeErr(w, http.StatusBadGateway, "Pocket Photos: "+err.Error())
				return
			}
			e.Target, openURL = id, c.public
		} else {
			c, err := s.conn(ctx, appFiles, scopeFilesWrite)
			if err != nil {
				s.failUser(w, err, "files")
				return
			}
			folder := strings.Trim(strings.TrimSpace(meta.Folder), "/")
			if meta.Folder == "" {
				st, _ := s.store.GetSettings(ctx, uid)
				folder = strings.Trim(st.FilesFolder, "/")
			}
			full := name
			if folder != "" {
				full = folder + "/" + name
			}
			ent, err := c.client.Upload(ctx, firstNonEmpty(meta.Space, "home"), "/", full, data)
			if err != nil {
				writeErr(w, http.StatusBadGateway, "Pocket Files: "+err.Error())
				return
			}
			e.Target = firstNonEmpty(ent.Path, "/"+full)
			openURL = c.public
		}
	default:
		writeErr(w, http.StatusBadRequest, "destination is download, photos or files")
		return
	}
	if err := s.store.CreateExport(ctx, uid, e); err != nil {
		s.fail(w, err, "export")
		return
	}
	payload := map[string]any{"export_id": e.ID, "destination": e.Destination, "format": e.Format, "width": e.Width, "height": e.Height, "target": e.Target}
	subject := fmt.Sprintf("export:%d", e.ID)
	if im != nil {
		payload["image_id"], payload["title"] = im.ID, im.Title
		subject = fmt.Sprintf("image:%d", im.ID)
	}
	s.publish(ctx, uid, "photolab.image_exported", subject, payload)
	writeJSON(w, http.StatusOK, map[string]any{"export": e, "open_url": openURL})
}

func (s *Server) handleListExports(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ex, err := s.store.ListExports(ctx, actorID(ctx), queryInt(r, "limit"))
	if err != nil {
		s.fail(w, err, "exports")
		return
	}
	writeJSON(w, http.StatusOK, ex)
}

// safeName is a file name with the right extension and nothing that could
// climb out of a folder.
func safeName(name, format string) string {
	name = strings.TrimSpace(strings.NewReplacer("/", "-", "\\", "-", "\x00", "", ":", "-").Replace(name))
	ext := "." + format
	if format == "jpeg" {
		ext = ".jpg"
	}
	base := name
	if e := path.Ext(name); len(e) >= 2 && len(e) <= 6 && strings.Trim(strings.ToLower(e[1:]), "abcdefghijklmnopqrstuvwxyz0123456789") == "" {
		base = strings.TrimSuffix(name, e)
	}
	if base == "" || strings.Trim(base, ".") == "" {
		base = "picture"
	}
	return clip(base, 120) + ext
}
