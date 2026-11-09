package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/config"
	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/imaging"
	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/store"
)

type app struct {
	t     *testing.T
	url   string
	s     *Server
	st    *store.Store
	alice string
	bob   string
	ids   map[string]int64
}

func newApp(t *testing.T, tweak func(*config.Config)) *app {
	t.Helper()
	cfg := testConfig(t.TempDir())
	cfg.BaseURL = "http://photolab.test"
	cfg.MaxBodyBytes = 64 << 20
	cfg.MaxUploadBytes = 32 << 20
	if tweak != nil {
		tweak(cfg)
	}
	st := openTestStore(t, cfg)
	ctx := context.Background()
	a := &app{t: t, st: st, ids: map[string]int64{}}
	for _, u := range []*store.User{{Email: "alice@example.com", Name: "Alice", Role: "admin"}, {Email: "bob@example.com", Name: "Bob", Role: "member"}} {
		if err := st.CreateUser(ctx, u); err != nil {
			t.Fatal(err)
		}
		tok, _, _ := st.CreateAPIToken(ctx, u.ID, "t")
		a.ids[u.Name] = u.ID
		if u.Name == "Alice" {
			a.alice = tok
		} else {
			a.bob = tok
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	t.Cleanup(cancel)
	a.s = New(cfg, st, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err := a.s.Bootstrap(ctx); err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(a.s.Router())
	t.Cleanup(ts.Close)
	a.url = ts.URL
	return a
}

func (a *app) do(auth string, req *http.Request) (int, []byte) {
	a.t.Helper()
	if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}

func (a *app) call(auth, method, path string, body any) (int, map[string]any, []any) {
	a.t.Helper()
	var rd io.Reader
	if body != nil {
		j, _ := json.Marshal(body)
		rd = bytes.NewReader(j)
	}
	req, _ := http.NewRequest(method, a.url+path, rd)
	req.Header.Set("Content-Type", "application/json")
	code, raw := a.do(auth, req)
	var m map[string]any
	var l []any
	if json.Unmarshal(raw, &m) != nil {
		_ = json.Unmarshal(raw, &l)
	}
	return code, m, l
}

func (a *app) expect(want int, auth, method, path string, body any) map[string]any {
	a.t.Helper()
	code, m, _ := a.call(auth, method, path, body)
	if code != want {
		a.t.Fatalf("%s %s → %d, want %d (%v)", method, path, code, want, m)
	}
	return m
}

// upload sends one picture as multipart and returns the response.
func (a *app) upload(auth, name string, data []byte) (int, map[string]any) {
	a.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", name)
	_, _ = fw.Write(data)
	_ = mw.Close()
	req, _ := http.NewRequest("POST", a.url+"/api/v1/images", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	code, raw := a.do(auth, req)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return code, m
}

func testPNG(w, h int, c color.RGBA) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = c.R, c.G, c.B, c.A
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

func num(m map[string]any, k string) float64 { v, _ := m[k].(float64); return v }

func firstID(t *testing.T, m map[string]any) int64 {
	t.Helper()
	id := int64(num(m, "id"))
	if id == 0 {
		t.Fatalf("no id in %v", m)
	}
	return id
}

func TestUploadEditAndIsolation(t *testing.T) {
	a := newApp(t, nil)
	code, m := a.upload(a.alice, "holiday_beach.png", testPNG(640, 480, color.RGBA{200, 120, 40, 255}))
	if code != http.StatusCreated {
		t.Fatalf("upload → %d %v", code, m)
	}
	id := firstID(t, m)
	p := "/api/v1/images/" + itoa(id)
	got := a.expect(200, a.alice, "GET", p, nil)["image"].(map[string]any)
	if got["title"] != "holiday beach" || num(got, "width") != 640 || num(got, "height") != 480 || got["edited"] != false {
		t.Fatalf("image = %v", got)
	}
	// the same bytes again: already in the lab, nothing new
	if code, m := a.upload(a.alice, "again.png", testPNG(640, 480, color.RGBA{200, 120, 40, 255})); code != http.StatusCreated || len(m["already"].([]any)) != 1 || len(m["items"].([]any)) != 0 {
		t.Fatalf("second upload → %d %v", code, m)
	}
	// an edit is a recipe
	up := a.expect(200, a.alice, "PUT", p, map[string]any{"recipe": map[string]any{"v": 1, "adjust": map[string]any{"exposure": 20}}, "favorite": true})["image"].(map[string]any)
	if up["edited"] != true || up["favorite"] != true {
		t.Fatalf("after edit = %v", up)
	}
	a.expect(400, a.alice, "PUT", p, map[string]any{"recipe": []int{1, 2}})
	// the rendered look becomes the preview and the thumbnail
	var jb bytes.Buffer
	_ = jpeg.Encode(&jb, image.NewRGBA(image.Rect(0, 0, 300, 200)), nil)
	req, _ := http.NewRequest("PUT", a.url+p+"/look", bytes.NewReader(jb.Bytes()))
	req.Header.Set("Content-Type", "image/jpeg")
	if code, b := a.do(a.alice, req); code != 200 {
		t.Fatalf("look → %d %s", code, b)
	}
	for _, sub := range []string{"/original", "/preview", "/thumb"} {
		req, _ := http.NewRequest("GET", a.url+p+sub, nil)
		if code, b := a.do(a.alice, req); code != 200 || imaging.Sniff(b) == "" {
			t.Fatalf("GET %s → %d (%d bytes)", sub, code, len(b))
		}
	}
	a.expect(201, a.alice, "POST", p+"/versions", map[string]any{"name": "Brighter", "recipe": map[string]any{"adjust": map[string]any{"exposure": 20}}})

	// Bob sees none of it
	for _, sub := range []string{"", "/original", "/preview", "/thumb", "/versions"} {
		a.expect(404, a.bob, "GET", p+sub, nil)
	}
	a.expect(404, a.bob, "PUT", p, map[string]any{"title": "mine now"})
	a.expect(404, a.bob, "POST", p+"/copy", nil)
	a.expect(404, a.bob, "DELETE", p, nil)
	a.expect(404, a.bob, "POST", p+"/versions", map[string]any{"name": "x", "recipe": map[string]any{}})
	if l := a.expect(200, a.bob, "GET", "/api/v1/images", nil); num(l, "total") != 0 {
		t.Fatalf("Bob's library = %v", l)
	}
	if code, _, l := a.call(a.bob, "GET", "/api/v1/images/"+itoa(id)+"/versions", nil); code != 404 || l != nil {
		t.Fatal("Bob listed Alice's versions")
	}

	// a copy shares the original; deleting one keeps the other working
	cp := a.expect(201, a.alice, "POST", p+"/copy", map[string]any{"fresh": true})["image"].(map[string]any)
	a.expect(204, a.alice, "DELETE", p, nil)
	req, _ = http.NewRequest("GET", a.url+"/api/v1/images/"+itoa(int64(num(cp, "id")))+"/original", nil)
	if code, _ := a.do(a.alice, req); code != 200 {
		t.Fatalf("copy's original after deleting the first → %d", code)
	}
}

func TestUploadRejectsNonPictures(t *testing.T) {
	a := newApp(t, nil)
	code, m := a.upload(a.alice, "notes.txt", []byte("hello, not a picture"))
	if code != http.StatusBadRequest || !strings.Contains(m["error"].(string), "not a picture") {
		t.Fatalf("text upload → %d %v", code, m)
	}
}

func TestPresetsAndExportImport(t *testing.T) {
	a := newApp(t, nil)
	_, m := a.upload(a.alice, "a.png", testPNG(64, 64, color.RGBA{10, 20, 30, 255}))
	id := firstID(t, m)
	a.expect(200, a.alice, "PUT", "/api/v1/images/"+itoa(id), map[string]any{"recipe": map[string]any{"adjust": map[string]any{"contrast": 30}}, "title": "Lake"})
	a.expect(201, a.alice, "POST", "/api/v1/images/"+itoa(id)+"/versions", map[string]any{"name": "v1", "recipe": map[string]any{"adjust": map[string]any{"contrast": 10}}})
	pr := a.expect(201, a.alice, "POST", "/api/v1/presets", map[string]any{"name": "Warm", "recipe": map[string]any{"adjust": map[string]any{"temperature": 20}}})
	a.expect(409, a.alice, "POST", "/api/v1/presets", map[string]any{"name": "Warm", "recipe": map[string]any{}})
	a.expect(404, a.bob, "PUT", "/api/v1/presets/"+itoa(int64(num(pr, "id"))), map[string]any{"name": "Bob's"})
	a.expect(404, a.bob, "DELETE", "/api/v1/presets/"+itoa(int64(num(pr, "id"))), nil)

	req, _ := http.NewRequest("GET", a.url+"/api/v1/export.json", nil)
	code, doc := a.do(a.alice, req)
	if code != 200 {
		t.Fatalf("export → %d", code)
	}
	var d exportDoc
	if err := json.Unmarshal(doc, &d); err != nil || len(d.Images) != 1 || len(d.Presets) != 1 || len(d.Versions) != 1 {
		t.Fatalf("export = %s", doc)
	}
	// importing your own export changes nothing, twice
	for i := 0; i < 2; i++ {
		req, _ := http.NewRequest("POST", a.url+"/api/v1/import", bytes.NewReader(doc))
		code, b := a.do(a.alice, req)
		if code != 200 || strings.TrimSpace(string(b)) != "{}" {
			t.Fatalf("import %d → %d %s", i, code, b)
		}
	}
	// Bob gets the looks but none of Alice's pictures
	req, _ = http.NewRequest("POST", a.url+"/api/v1/import", bytes.NewReader(doc))
	_, b := a.do(a.bob, req)
	var counts map[string]int
	_ = json.Unmarshal(b, &counts)
	if counts["looks"] != 1 || counts["pictures"] != 0 || counts["pictures not here"] != 1 {
		t.Fatalf("Bob's import = %s", b)
	}
	if l := a.expect(200, a.bob, "GET", "/api/v1/images", nil); num(l, "total") != 0 {
		t.Fatal("import gave Bob a picture")
	}
}

func TestSettingsArePersonal(t *testing.T) {
	a := newApp(t, nil)
	a.expect(200, a.alice, "PUT", "/api/v1/settings", map[string]any{"export_format": "png", "title": "Our lab", "files_folder": "Edits/2026"})
	a.expect(400, a.alice, "PUT", "/api/v1/settings", map[string]any{"export_format": "gif"})
	a.expect(400, a.alice, "PUT", "/api/v1/settings", map[string]any{"files_folder": "../etc"})
	bob := a.expect(200, a.bob, "PUT", "/api/v1/settings", map[string]any{"title": "Bob's lab"})
	if bob["export_format"] != "jpeg" || bob["title"] != "Our lab" {
		t.Fatalf("Bob's settings = %v", bob)
	}
	al := a.expect(200, a.alice, "GET", "/api/v1/settings", nil)
	if al["export_format"] != "png" || al["files_folder"] != "/Edits/2026" {
		t.Fatalf("Alice's settings = %v", al)
	}
}

func TestExportLog(t *testing.T) {
	a := newApp(t, nil)
	_, m := a.upload(a.alice, "a.png", testPNG(32, 32, color.RGBA{1, 2, 3, 255}))
	id := firstID(t, m)
	a.expect(200, a.alice, "POST", "/api/v1/exports", map[string]any{"image_id": id, "destination": "download", "format": "jpeg", "width": 32, "height": 32, "name": "a-edited"})
	a.expect(404, a.bob, "POST", "/api/v1/exports", map[string]any{"image_id": id, "destination": "download", "format": "jpeg"})
	// without Pocket Core or a token, Photos is not set up: a plain message, not a crash
	code, m2, _ := a.call(a.alice, "GET", "/api/v1/sources/photos", nil)
	if code != http.StatusConflict || !strings.Contains(m2["error"].(string), "Pocket Photos") {
		t.Fatalf("photos without a connection → %d %v", code, m2)
	}
	if got := a.expect(200, a.alice, "GET", "/api/v1/images/"+itoa(id), nil)["image"].(map[string]any); num(got, "exports") != 1 {
		t.Fatalf("exports counted = %v", got["exports"])
	}
}

func TestLinkScopes(t *testing.T) {
	cases := []struct {
		method, path string
		scopes       []string
		want         bool
	}{
		{"GET", "/api/v1/auth/me", nil, true},
		{"GET", "/api/v1/images", []string{"photolab:read"}, true},
		{"GET", "/api/v1/images/12/preview", []string{"photolab:read"}, true},
		{"GET", "/api/v1/images", []string{"photolab:write"}, false},
		{"POST", "/api/v1/images", []string{"photolab:write"}, true},
		{"POST", "/api/v1/images", []string{"photolab:read"}, false},
		{"PUT", "/api/v1/images/3", []string{"photolab:write"}, true},
		{"PUT", "/api/v1/images/3/look", []string{"photolab:write"}, false},
		{"GET", "/api/v1/settings", []string{"photolab:read", "photolab:write"}, false},
		{"GET", "/api/v1/export.json", []string{"photolab:read"}, false},
		{"POST", "/api/v1/exports", []string{"photolab:write"}, false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(c.method, c.path, nil)
		if got := linkAllows(c.scopes, r); got != c.want {
			t.Errorf("%s %s %v = %v, want %v", c.method, c.path, c.scopes, got, c.want)
		}
	}
}

// A phone photo stored sideways with EXIF orientation 6 is shown upright:
// width and height swap.
func TestProbeOrientation(t *testing.T) {
	var jb bytes.Buffer
	_ = jpeg.Encode(&jb, image.NewRGBA(image.Rect(0, 0, 40, 20)), nil)
	raw := jb.Bytes()
	tiff := []byte("MM\x00\x2a\x00\x00\x00\x08")
	ifd := make([]byte, 2+12+4)
	binary.BigEndian.PutUint16(ifd[0:], 1)
	binary.BigEndian.PutUint16(ifd[2:], 0x0112)
	binary.BigEndian.PutUint16(ifd[4:], 3)
	binary.BigEndian.PutUint32(ifd[6:], 1)
	binary.BigEndian.PutUint16(ifd[10:], 6)
	payload := append([]byte("Exif\x00\x00"), append(tiff, ifd...)...)
	seg := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(seg[2:], uint16(len(payload)+2))
	withExif := append(append(append([]byte{}, raw[:2]...), append(seg, payload...)...), raw[2:]...)
	in, err := imaging.Probe(withExif)
	if err != nil || in.Orientation != 6 || in.Width != 20 || in.Height != 40 {
		t.Fatalf("probe = %+v, %v", in, err)
	}
	img, err := imaging.Decode(withExif)
	if err != nil || img.Bounds().Dx() != 20 || img.Bounds().Dy() != 40 {
		t.Fatalf("decode = %v, %v", img.Bounds(), err)
	}
}

func TestSafeName(t *testing.T) {
	for in, want := range map[string]string{"../../etc/passwd": "..-..-etc-passwd.jpg", "Lake.png": "Lake.jpg", "": "picture.jpg", "a/b:c": "a-b-c.jpg"} {
		if got := safeName(in, "jpeg"); got != want {
			t.Errorf("safeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func itoa(n int64) string { b, _ := json.Marshal(n); return string(b) }

func TestApplyChangesTheEdit(t *testing.T) {
	a := newApp(t, nil)
	_, m := a.upload(a.alice, "a.png", testPNG(400, 200, color.RGBA{90, 120, 200, 255}))
	id := firstID(t, m)
	a.expect(201, a.alice, "POST", "/api/v1/presets", map[string]any{"name": "Warm evening", "recipe": map[string]any{"adjust": map[string]any{"temperature": 25}}})
	out := a.expect(200, a.alice, "POST", "/api/v1/images/apply", map[string]any{"ids": []int64{id}, "look": "film", "strength": 60, "adjust": map[string]any{"exposure": 250}, "aspect": "1:1", "long_edge": 100})
	im := out["items"].([]any)[0].(map[string]any)
	rec := im["recipe"].(map[string]any)
	crop := rec["crop"].(map[string]any)
	if rec["look"].(map[string]any)["name"] != "film" || rec["adjust"].(map[string]any)["exposure"] != 100.0 || crop["w"] != 0.5 || crop["h"] != 1.0 || im["stale"] != true {
		t.Fatalf("apply = %v", im)
	}
	if rs := rec["resize"].(map[string]any); rs["w"] != 100.0 || rs["h"] != 100.0 {
		t.Fatalf("resize = %v", rs)
	}
	out = a.expect(200, a.alice, "POST", "/api/v1/images/apply", map[string]any{"ids": []int64{id}, "look": "Warm evening"})
	rec = out["items"].([]any)[0].(map[string]any)["recipe"].(map[string]any)
	if rec["look"] != nil || rec["adjust"].(map[string]any)["temperature"] != 25.0 || rec["crop"] == nil {
		t.Fatalf("own look = %v", rec)
	}
	if l := a.expect(200, a.alice, "GET", "/api/v1/images?show=stale", nil); num(l, "total") != 1 {
		t.Fatalf("stale list = %v", l)
	}
	a.expect(400, a.alice, "POST", "/api/v1/images/apply", map[string]any{"ids": []int64{id}, "look": "nope"})
	a.expect(400, a.alice, "POST", "/api/v1/images/apply", map[string]any{"ids": []int64{id}, "adjust": map[string]any{"wobble": 3}})
	a.expect(404, a.bob, "POST", "/api/v1/images/apply", map[string]any{"ids": []int64{id}, "look": "film"})
}

// A RAW file: the lab keeps the camera's full-size JPEG from inside it.
func TestRawUsesTheCamerasJPEG(t *testing.T) {
	a := newApp(t, nil)
	var small, big bytes.Buffer
	_ = jpeg.Encode(&small, image.NewRGBA(image.Rect(0, 0, 160, 120)), nil)
	_ = jpeg.Encode(&big, image.NewRGBA(image.Rect(0, 0, 900, 600)), nil)
	raw := append([]byte("II*\x00\x08\x00\x00\x00\x00\x00junk-sensor-data"), small.Bytes()...)
	raw = append(append(raw, []byte("more sensor data")...), big.Bytes()...)
	raw = append(raw, []byte("trailing")...)
	code, m := a.upload(a.alice, "DSC0042.ARW", raw)
	if code != http.StatusCreated {
		t.Fatalf("raw upload → %d %v", code, m)
	}
	im := m["items"].([]any)[0].(map[string]any)
	if im["mime"] != "image/jpeg" || num(im, "width") != 900 || num(im, "height") != 600 || im["source_name"] != "DSC0042.ARW" {
		t.Fatalf("raw = %v", im)
	}
	if code, _ := a.upload(a.alice, "empty.NEF", []byte("II*\x00 no pictures here")); code != http.StatusBadRequest {
		t.Fatalf("raw without a picture → %d", code)
	}
}

func TestFontsArePersonal(t *testing.T) {
	a := newApp(t, nil)
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "Lobster.ttf")
	_, _ = fw.Write(append([]byte("\x00\x01\x00\x00"), make([]byte, 200)...))
	_ = mw.Close()
	req, _ := http.NewRequest("POST", a.url+"/api/v1/fonts", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	code, b := a.do(a.alice, req)
	var f map[string]any
	_ = json.Unmarshal(b, &f)
	if code != 201 || f["name"] != "Lobster" || f["mime"] != "font/ttf" {
		t.Fatalf("font upload → %d %s", code, b)
	}
	p := "/api/v1/fonts/" + itoa(int64(num(f, "id")))
	a.expect(404, a.bob, "GET", p+"/file", nil)
	a.expect(404, a.bob, "DELETE", p, nil)
	if _, _, l := a.call(a.bob, "GET", "/api/v1/fonts", nil); len(l) != 0 {
		t.Fatalf("Bob sees fonts %v", l)
	}
	req, _ = http.NewRequest("GET", a.url+p+"/file", nil)
	if code, _ := a.do(a.alice, req); code != 200 {
		t.Fatalf("font file → %d", code)
	}
	a.expect(204, a.alice, "DELETE", p, nil)
}
