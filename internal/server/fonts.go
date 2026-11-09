package server

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/store"
)

// ---- fonts of one's own, for text on pictures ----

func fontMime(b []byte) (string, string) {
	if len(b) < 4 {
		return "", ""
	}
	switch string(b[:4]) {
	case "\x00\x01\x00\x00", "true":
		return "font/ttf", ".ttf"
	case "OTTO":
		return "font/otf", ".otf"
	case "wOFF":
		return "font/woff", ".woff"
	case "wOF2":
		return "font/woff2", ".woff2"
	}
	return "", ""
}

func (s *Server) handleListFonts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	fs, err := s.store.ListFonts(ctx, actorID(ctx))
	if err != nil {
		s.fail(w, err, "fonts")
		return
	}
	writeJSON(w, http.StatusOK, fs)
}

func (s *Server) handleUploadFont(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := actorID(ctx)
	r.Body = http.MaxBytesReader(w, r.Body, 12<<20)
	f, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "send the font as multipart \"file\" (TTF, OTF, WOFF or WOFF2, up to 10 MB)")
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 10<<20+1))
	if err != nil || len(data) > 10<<20 {
		writeErr(w, http.StatusBadRequest, "fonts can be up to 10 MB")
		return
	}
	mime, ext := fontMime(data)
	if mime == "" {
		writeErr(w, http.StatusBadRequest, "that is not a TTF, OTF, WOFF or WOFF2 font")
		return
	}
	rel, err := s.writeFile(uid, "fonts", ext, data)
	if err != nil {
		s.fail(w, err, "font")
		return
	}
	name := clip(strings.TrimSpace(firstNonEmpty(r.FormValue("name"), titleFromName(hdr.Filename))), 80)
	ft := &store.Font{Name: name, File: rel, Mime: mime, Bytes: int64(len(data))}
	if err := s.store.CreateFont(ctx, uid, ft); err != nil {
		_ = os.Remove(s.filePath(rel))
		s.fail(w, err, "font")
		return
	}
	writeJSON(w, http.StatusCreated, ft)
}

func (s *Server) handleFontFile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ft, err := s.store.GetFont(ctx, actorID(ctx), idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "font")
		return
	}
	f, err := os.Open(s.filePath(ft.File))
	if err != nil {
		writeErr(w, http.StatusNotFound, "the font file is missing")
		return
	}
	defer f.Close()
	fi, _ := f.Stat()
	w.Header().Set("Content-Type", ft.Mime)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeContent(w, r, fmt.Sprintf("font-%d", ft.ID), fi.ModTime(), f)
}

func (s *Server) handleDeleteFont(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ft, err := s.store.DeleteFont(ctx, actorID(ctx), idParam(r, "id"))
	if err != nil {
		s.fail(w, err, "font")
		return
	}
	_ = os.Remove(s.filePath(ft.File))
	w.WriteHeader(http.StatusNoContent)
}
