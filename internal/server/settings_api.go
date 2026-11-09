package server

import (
	"archive/zip"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/ai"
	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/pocket"
	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/store"
)

// ---- settings ----

func mask(s string) string {
	if s == "" {
		return ""
	}
	if len(s) <= 8 {
		return "••••"
	}
	return s[:4] + "••••" + s[len(s)-4:]
}

// publicSettings is what one person sees: their settings with the secrets
// masked and, per Pocket app, the mode in effect (<app>_mode), whether it
// works and how (<app>_via: core | direct | "") and why not (<app>_detail).
func (s *Server) publicSettings(ctx context.Context, u *store.User, st store.Settings) map[string]any {
	out := map[string]any{
		"core_configured": s.core.Configured(), "core_registered": s.coreStatus()["registered"],
		"title": st.Title, "date_format": st.DateFormat, "time_format": st.TimeFormat, "week_start": st.WeekStart,
		"export_format": st.ExportFormat, "export_quality": st.ExportQuality, "export_max_edge": st.ExportMaxEdge, "export_name": st.ExportName,
		"save_to": st.SaveTo, "files_folder": st.FilesFolder,
		"preview_size": st.PreviewSize, "show_grid": st.ShowGrid, "histogram": st.Histogram, "compare_style": st.CompareStyle, "confirm_leave": st.ConfirmLeave, "sort": st.Sort,
		"photos_url": st.PhotosURL, "photos_token": mask(st.PhotosToken), "photos_public_url": st.PhotosPublicURL,
		"files_url": st.FilesURL, "files_token": mask(st.FilesToken), "files_public_url": st.FilesPublicURL,
		"ai_provider": st.AIProvider, "ai_pocket_model": st.AIPocketModel, "ai_photos": st.AIPhotos,
		"openai_api_key": mask(st.OpenAIKey), "openai_model": st.OpenAIModel, "openai_base_url": st.OpenAIBaseURL,
		"setup_complete": st.SetupComplete, "base_url": s.cfg.BaseURL, "max_upload_mb": s.cfg.MaxUploadBytes >> 20,
	}
	for _, a := range pocketApps {
		mode, via, detail := s.connStatus(ctx, u, st, a)
		out[a.slug+"_mode"], out[a.slug+"_via"], out[a.slug+"_detail"] = mode, via, detail
		out[a.slug+"_configured"] = via != ""
		_, _, _, public := connSettings(st, a)
		if public == "" && via != "" {
			public = s.resolveSibling(ctx, a.slug)
		}
		out[a.slug+"_open_url"] = public
	}
	return out
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	st, err := s.store.GetSettings(r.Context(), actorID(r.Context()))
	if err != nil {
		s.fail(w, err, "settings")
		return
	}
	writeJSON(w, http.StatusOK, s.publicSettings(r.Context(), userFrom(r.Context()), st))
}

// handlePutSettings saves the caller's personal settings. The box-wide title
// is only taken from an admin.
func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	me := userFrom(r.Context())
	isAdmin := me.Role == "admin"
	cur, err := s.store.GetSettings(r.Context(), me.ID)
	if err != nil {
		s.fail(w, err, "settings")
		return
	}
	var in store.Settings
	keys, err := decodeKeys(r, &in)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	bad := func(msg string) { writeErr(w, http.StatusBadRequest, msg) }
	if keys["title"] && isAdmin {
		cur.Title = strings.TrimSpace(in.Title)
		if cur.Title == "" {
			cur.Title = store.DefaultTitle
		}
	}
	if keys["date_format"] {
		cur.DateFormat = in.DateFormat
	}
	if keys["time_format"] {
		cur.TimeFormat = in.TimeFormat
	}
	if keys["week_start"] && (in.WeekStart == 1 || in.WeekStart == 7 || in.WeekStart == 6) {
		cur.WeekStart = in.WeekStart
	}
	intIn := func(k string, dst *int, v, lo, hi int) bool {
		if !keys[k] {
			return true
		}
		if v < lo || v > hi {
			bad(fmt.Sprintf("%s is %d to %d", k, lo, hi))
			return false
		}
		*dst = v
		return true
	}
	if !intIn("export_max_edge", &cur.ExportMaxEdge, in.ExportMaxEdge, 0, 20000) || !intIn("preview_size", &cur.PreviewSize, in.PreviewSize, 1200, 4096) {
		return
	}
	pick := func(k string, dst *string, v string, allowed []string) bool {
		if !keys[k] {
			return true
		}
		for _, a := range allowed {
			if v == a {
				*dst = v
				return true
			}
		}
		bad(fmt.Sprintf("%s must be one of %s", k, strings.Join(allowed, ", ")))
		return false
	}
	if !pick("export_format", &cur.ExportFormat, in.ExportFormat, []string{"jpeg", "png", "webp", "avif"}) ||
		!pick("save_to", &cur.SaveTo, in.SaveTo, []string{"download", "photos", "files"}) ||
		!pick("compare_style", &cur.CompareStyle, in.CompareStyle, []string{"hold", "split"}) ||
		!pick("sort", &cur.Sort, in.Sort, []string{"recent", "added", "title", "taken", "size"}) {
		return
	}
	if keys["export_quality"] {
		if in.ExportQuality < 0.3 || in.ExportQuality > 1 {
			bad("quality is 30 to 100%")
			return
		}
		cur.ExportQuality = in.ExportQuality
	}
	secret := func(k string, dst *string, v string) {
		if keys[k] && !strings.Contains(v, "••") {
			*dst = strings.TrimSpace(v)
		}
	}
	url := func(k string, dst *string, v string) {
		if keys[k] {
			*dst = strings.TrimRight(strings.TrimSpace(v), "/")
		}
	}
	text := func(k string, dst *string, v string, n int) {
		if keys[k] {
			*dst = clip(strings.TrimSpace(v), n)
		}
	}
	boolIn := func(k string, dst *bool, v bool) {
		if keys[k] {
			*dst = v
		}
	}
	text("export_name", &cur.ExportName, in.ExportName, 120)
	if cur.ExportName == "" {
		cur.ExportName = "{title}-edited"
	}
	if keys["files_folder"] {
		cur.FilesFolder = "/" + strings.Trim(strings.TrimSpace(strings.ReplaceAll(in.FilesFolder, "\\", "/")), "/")
		if strings.Contains(cur.FilesFolder, "..") {
			bad("the folder can't contain ..")
			return
		}
	}
	boolIn("show_grid", &cur.ShowGrid, in.ShowGrid)
	boolIn("histogram", &cur.Histogram, in.Histogram)
	boolIn("confirm_leave", &cur.ConfirmLeave, in.ConfirmLeave)
	boolIn("ai_photos", &cur.AIPhotos, in.AIPhotos)
	url("photos_url", &cur.PhotosURL, in.PhotosURL)
	secret("photos_token", &cur.PhotosToken, in.PhotosToken)
	url("photos_public_url", &cur.PhotosPublicURL, in.PhotosPublicURL)
	url("files_url", &cur.FilesURL, in.FilesURL)
	secret("files_token", &cur.FilesToken, in.FilesToken)
	url("files_public_url", &cur.FilesPublicURL, in.FilesPublicURL)
	if keys["ai_provider"] {
		if !validAIProvider(in.AIProvider) {
			bad("AI is automatic, Pocket AI or OpenAI")
			return
		}
		cur.AIProvider = in.AIProvider
	}
	if keys["ai_pocket_model"] {
		if !validPocketModel(in.AIPocketModel) {
			bad("unknown model")
			return
		}
		cur.AIPocketModel = in.AIPocketModel
	}
	secret("openai_api_key", &cur.OpenAIKey, in.OpenAIKey)
	text("openai_model", &cur.OpenAIModel, in.OpenAIModel, 120)
	url("openai_base_url", &cur.OpenAIBaseURL, in.OpenAIBaseURL)
	mode := func(k string, dst *string, v string) {
		if keys[k] && (v == modeCore || v == modeDirect || v == modeOff) {
			*dst = v
		}
	}
	mode("photos_mode", &cur.PhotosMode, in.PhotosMode)
	mode("files_mode", &cur.FilesMode, in.FilesMode)
	if err := s.store.SaveUserSettings(r.Context(), me.ID, cur); err != nil {
		s.fail(w, err, "save settings")
		return
	}
	if isAdmin && keys["title"] {
		if err := s.store.SaveBoxSettings(r.Context(), cur); err != nil {
			s.fail(w, err, "save settings")
			return
		}
	}
	for _, k := range modeKeys {
		if keys[k] {
			s.reportModesSoon()
			break
		}
	}
	writeJSON(w, http.StatusOK, s.publicSettings(r.Context(), me, cur))
}

// handleIntegrationTest checks a connection with the caller's own saved
// settings (or the URL/key typed into the form).
func (s *Server) handleIntegrationTest(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Which string `json:"which"`
		URL   string `json:"url"`
		Key   string `json:"key"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	uid := actorID(r.Context())
	st, _ := s.store.GetSettings(r.Context(), uid)
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	keyOr := func(saved string) string {
		if strings.Contains(in.Key, "••") || in.Key == "" {
			return saved
		}
		return in.Key
	}
	urlOr := func(saved string) string {
		if strings.TrimSpace(in.URL) == "" {
			return saved
		}
		return strings.TrimRight(strings.TrimSpace(in.URL), "/")
	}
	var msg string
	var err error
	if a, ok := appBySlug(in.Which); ok {
		mode, savedURL, savedTok, _ := connSettings(st, a)
		typed := in.Key != "" && !strings.Contains(in.Key, "••")
		var conn *siblingConn
		if tok := keyOr(savedTok); tok != "" && (typed || s.connMode(mode, savedTok) == modeDirect) {
			base := urlOr(savedURL)
			if base == "" {
				base = s.resolveSibling(ctx, a.slug)
			}
			conn = &siblingConn{client: pocket.New(base, tok, 15*time.Second), via: modeDirect}
		} else {
			conn, err = s.clients(ctx, uid).conn(ctx, a, a.scopes[0])
		}
		if err == nil {
			how := "direct connection"
			if conn.via == modeCore {
				how = "through Pocket Core"
			}
			var v string
			if v, err = conn.client.Health(ctx); err == nil {
				switch a.slug {
				case "photos":
					var items []pocket.Asset
					items, _, err = conn.client.SearchPhotos(ctx, "", "", 1, false)
					what := "your library answers"
					if err == nil && len(items) == 0 {
						what = "your library is empty"
					}
					msg = fmt.Sprintf("Pocket Photos %s, %s, %s", v, how, what)
				case "files":
					var sp []pocket.Space
					sp, err = conn.client.Spaces(ctx)
					msg = fmt.Sprintf("Pocket Files %s, %s, %d places", v, how, len(sp))
				}
			}
		}
	} else if in.Which == "openai" {
		c := ai.New(urlOr(st.OpenAIBaseURL), keyOr(st.OpenAIKey), st.OpenAIModel, 20*time.Second)
		var ids []string
		if ids, err = c.Models(ctx); err == nil {
			msg = fmt.Sprintf("The key works (%d models)", len(ids))
		}
	} else {
		writeErr(w, http.StatusBadRequest, "unknown integration")
		return
	}
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "message": msg})
}

// ---- system / backup / export ----

func (s *Server) handleSystemInfo(w http.ResponseWriter, r *http.Request) {
	var size int64
	if fi, err := os.Stat(s.cfg.DBPath); err == nil {
		size = fi.Size()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version": Version, "go": runtime.Version(), "os": runtime.GOOS, "arch": runtime.GOARCH,
		"core":      s.coreStatus(),
		"auth_mode": s.cfg.AuthMode, "data_dir": s.cfg.DataDir, "db_path": s.cfg.DBPath, "db_bytes": size,
		"uptime": time.Since(s.started).Round(time.Second).String(), "timezone": time.Now().Location().String(),
		"counts": s.store.CountsFor(r.Context(), actorID(r.Context())), "image_bytes": s.store.ImageBytes(r.Context(), actorID(r.Context())), "images_dir": s.cfg.ImagesDir,
	})
}

// handleBackup downloads the whole database, an admin-only box operation.
func (s *Server) handleBackup(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	dir := filepath.Join(s.cfg.DataDir, "backups")
	name := fmt.Sprintf("pocket-photolab-%s.db", time.Now().Format("20060102-150405"))
	dst := filepath.Join(dir, name)
	if err := s.store.Backup(r.Context(), dst); err != nil {
		s.fail(w, err, "backup")
		return
	}
	w.Header().Set("Content-Type", "application/vnd.sqlite3")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	http.ServeFile(w, r, dst)
}

// exportDoc is the JSON export of one person's data: every picture's
// details and edit, the saved versions, the looks and the export log. The
// pictures themselves are in IMAGES_DIR (and in export.zip).
type exportDoc struct {
	App      string          `json:"app"`
	Version  string          `json:"version"`
	Exported string          `json:"exported_at"`
	Images   []store.Image   `json:"images"`
	Versions []store.Version `json:"versions"`
	Presets  []store.Preset  `json:"presets"`
	Exports  []store.Export  `json:"exports"`
}

func (s *Server) exportDoc(ctx context.Context, uid int64) exportDoc {
	doc := exportDoc{App: "pocket-photolab", Version: Version, Exported: store.Now(), Versions: []store.Version{}}
	doc.Images, _, _ = s.store.ListImages(ctx, uid, store.ImageFilter{Sort: "added", Limit: 500})
	for off := 500; ; off += 500 {
		more, _, _ := s.store.ListImages(ctx, uid, store.ImageFilter{Sort: "added", Limit: 500, Offset: off})
		if len(more) == 0 {
			break
		}
		doc.Images = append(doc.Images, more...)
	}
	for _, im := range doc.Images {
		if vs, err := s.store.ListVersions(ctx, uid, im.ID); err == nil {
			doc.Versions = append(doc.Versions, vs...)
		}
	}
	doc.Presets, _ = s.store.ListPresets(ctx, uid)
	doc.Exports, _ = s.store.ListExports(ctx, uid, 1000)
	return doc
}

func (s *Server) handleExportJSON(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	w.Header().Set("Content-Disposition", `attachment; filename="pocket-photolab-export.json"`)
	writeJSON(w, http.StatusOK, s.exportDoc(ctx, actorID(ctx)))
}

// handleExportCSV writes one row per picture.
func (s *Server) handleExportCSV(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	doc := s.exportDoc(ctx, actorID(ctx))
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="pocket-photolab-pictures.csv"`)
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"id", "title", "file_name", "type", "width", "height", "bytes", "source", "edited", "favorite", "taken_at", "added_at", "edited_at", "exports", "note"})
	for _, im := range doc.Images {
		_ = cw.Write([]string{strconv.FormatInt(im.ID, 10), im.Title, im.SourceName, im.Mime, strconv.Itoa(im.Width), strconv.Itoa(im.Height), strconv.FormatInt(im.Bytes, 10),
			im.Source, strconv.FormatBool(im.Edited), strconv.FormatBool(im.Favorite), im.TakenAt, im.CreatedAt, im.EditedAt, strconv.Itoa(im.Exports), im.Note})
	}
	cw.Flush()
}

// handleImportJSON merges an export into the caller's own data: looks by
// name, and edits, titles and versions for pictures that are already here
// (matched by their bytes). Importing the same file twice adds nothing.
func (s *Server) handleImportJSON(w http.ResponseWriter, r *http.Request) {
	var doc exportDoc
	if err := decode(r, &doc); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	if doc.App != "" && doc.App != "pocket-photolab" {
		writeErr(w, http.StatusBadRequest, "this is not a Pocket Photo Lab export")
		return
	}
	ctx := r.Context()
	uid := actorID(ctx)
	counts := map[string]int{}
	have, _ := s.store.ListPresets(ctx, uid)
	names := map[string]bool{}
	for _, p := range have {
		names[strings.ToLower(p.Name)] = true
	}
	for _, p := range doc.Presets {
		p.Name = clip(strings.TrimSpace(p.Name), 80)
		if p.Name == "" || names[strings.ToLower(p.Name)] || !json.Valid(p.Recipe) {
			continue
		}
		if err := s.store.CreatePreset(ctx, uid, &store.Preset{Name: p.Name, Recipe: p.Recipe, Sort: p.Sort}, nil); err == nil {
			names[strings.ToLower(p.Name)] = true
			counts["looks"]++
		}
	}
	ids := map[int64]int64{}
	for _, im := range doc.Images {
		if im.SHA256 == "" {
			continue
		}
		mine, err := s.store.FindImage(ctx, uid, "", "", im.SHA256)
		if err != nil {
			counts["pictures not here"]++
			continue
		}
		ids[im.ID] = mine.ID
		if string(mine.Recipe) == string(im.Recipe) && mine.Title == im.Title {
			continue
		}
		if !mine.Edited && json.Valid(im.Recipe) {
			mine.Recipe, mine.Edited, mine.EditedAt = im.Recipe, im.Edited, im.EditedAt
		}
		mine.Title, mine.Note, mine.Favorite = firstNonEmpty(im.Title, mine.Title), firstNonEmpty(mine.Note, im.Note), mine.Favorite || im.Favorite
		if err := s.store.UpdateImage(ctx, uid, mine); err == nil {
			counts["pictures"]++
		}
	}
	for _, v := range doc.Versions {
		id, ok := ids[v.ImageID]
		if !ok {
			continue
		}
		existing, _ := s.store.ListVersions(ctx, uid, id)
		dup := false
		for _, e := range existing {
			if e.Name == v.Name && string(e.Recipe) == string(v.Recipe) {
				dup = true
				break
			}
		}
		if dup || !json.Valid(v.Recipe) {
			continue
		}
		if err := s.store.CreateVersion(ctx, uid, &store.Version{ImageID: id, Name: v.Name, Recipe: v.Recipe}, nil); err == nil {
			counts["versions"]++
		}
	}
	writeJSON(w, http.StatusOK, counts)
}

// handleExportZip downloads everything of one person's: every original, the
// current look of each edited picture, and export.json.
func (s *Server) handleExportZip(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	doc := s.exportDoc(ctx, actorID(ctx))
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="pocket-photolab-`+time.Now().Format("20060102")+`.zip"`)
	zw := zip.NewWriter(w)
	defer zw.Close()
	used := map[string]bool{}
	name := func(dir, base, ext string) string {
		base = strings.NewReplacer("/", "-", "\\", "-", ":", "-").Replace(base)
		n := dir + "/" + base + ext
		for i := 2; used[n]; i++ {
			n = fmt.Sprintf("%s/%s (%d)%s", dir, base, i, ext)
		}
		used[n] = true
		return n
	}
	add := func(zipName, rel string) {
		f, err := os.Open(s.filePath(rel))
		if err != nil {
			return
		}
		defer f.Close()
		zf, err := zw.CreateHeader(&zip.FileHeader{Name: zipName, Method: zip.Store, Modified: time.Now()})
		if err == nil {
			_, _ = io.Copy(zf, f)
		}
	}
	for _, im := range doc.Images {
		add(name("originals", fmt.Sprintf("%d %s", im.ID, im.Title), filepath.Ext(im.File)), im.File)
		if im.Preview != "" {
			add(name("edited", fmt.Sprintf("%d %s", im.ID, im.Title), filepath.Ext(im.Preview)), im.Preview)
		}
	}
	if jf, err := zw.Create("export.json"); err == nil {
		enc := json.NewEncoder(jf)
		enc.SetIndent("", "  ")
		_ = enc.Encode(doc)
	}
}
