package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image/color"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	core "github.com/abjelosevic88/pocket-homelab-core/sdk"
	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/config"
)

// newMoveApp is newApp behind a Pocket Core that vouches for Pocket Move's
// link tokens: pcx_<alice|bob>_<in|out|read> (move:import / move:export / another scope).
func newMoveApp(t *testing.T) *app {
	t.Helper()
	coreSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/api/v1/auth/introspect" {
			io.WriteString(w, `{}`)
			return
		}
		var in struct{ Token string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		parts := strings.Split(in.Token, "_")
		if len(parts) != 3 || parts[0] != "pcx" {
			io.WriteString(w, `{"active":false}`)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"active": true, "kind": "delegated", "audience": "photolab",
			"scope": map[string]string{"in": core.ScopeMoveImport, "out": core.ScopeMoveExport, "read": "photolab:read"}[parts[2]],
			"user":  map[string]any{"id": 1, "sub": parts[1] + "@example.com", "email": parts[1] + "@example.com", "name": parts[1], "role": "member"},
			"app":   map[string]any{"id": 9, "slug": "move", "name": "Pocket Move"}})
	}))
	t.Cleanup(coreSrv.Close)
	return newApp(t, func(c *config.Config) { c.CoreURL = coreSrv.URL })
}

func (a *app) moveRaw(auth, method, path, ctype string, body []byte) (int, []byte) {
	a.t.Helper()
	req, _ := http.NewRequest(method, a.url+path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+auth)
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}

// moveImport posts a file to an import as Pocket Move does and returns the answer.
func (a *app) moveImport(auth, path, ctype string, body []byte) map[string]any {
	a.t.Helper()
	code, out := a.moveRaw(auth, "POST", path, ctype, body)
	if code != 200 {
		a.t.Fatalf("POST %s → %d %s", path, code, out)
	}
	var m map[string]any
	_ = json.Unmarshal(out, &m)
	return m
}

type moveCase struct {
	tok, method, path string
	want              int
}

// checkMoveScopes: move:export reaches the description and the exports,
// move:import the description and the imports, another scope neither.
func checkMoveScopes(t *testing.T, a *app, exports, imports int, cases []moveCase) {
	t.Helper()
	for _, c := range append([]moveCase{
		{"pcx_bob_out", "GET", core.PortablePath, 200},
		{"pcx_bob_in", "GET", core.PortablePath, 200},
		{"pcx_bob_read", "GET", core.PortablePath, 403},
		{"pcx_bob_out", "GET", "/api/v1/settings", 403},
		{"pcx_bob_in", "PUT", "/api/v1/settings", 403},
		{"pcx_bob_out", "GET", "/api/v1/backup", 403},
	}, cases...) {
		if code, body := a.moveRaw(c.tok, c.method, c.path, "application/json", []byte("{}")); code != c.want {
			t.Errorf("%s %s %s → %d, want %d (%s)", c.tok, c.method, c.path, code, c.want, body)
		}
	}
	_, body := a.moveRaw("pcx_bob_out", "GET", core.PortablePath, "", nil)
	var p core.Portable
	if err := json.Unmarshal(body, &p); err != nil || len(p.Exports) != exports || len(p.Imports) != imports {
		t.Fatalf("portable: %s", body)
	}
	kinds := 0
	for _, e := range p.Exports {
		if e.Kind == core.KindPocket {
			kinds++
		}
	}
	if kinds != 1 {
		t.Fatalf("exactly one pocket export: %s", body)
	}
}

func (a *app) moveExport(auth, path string) []byte {
	a.t.Helper()
	code, b := a.moveRaw(auth, "GET", path, "", nil)
	if code != 200 {
		a.t.Fatalf("GET %s → %d %s", path, code, b)
	}
	return b
}

func TestMoveLinkScopes(t *testing.T) {
	a := newMoveApp(t)
	checkMoveScopes(t, a, 2, 1, []moveCase{
		{"pcx_bob_out", "GET", "/api/v1/export.zip", 200},
		{"pcx_bob_out", "GET", "/api/v1/export.csv", 200},
		{"pcx_bob_out", "GET", "/api/v1/export.json", 403},
		{"pcx_bob_out", "POST", "/api/v1/import", 403},
		{"pcx_bob_out", "GET", "/api/v1/images", 403},
		{"pcx_bob_in", "GET", "/api/v1/export.zip", 403},
		{"pcx_bob_in", "POST", "/api/v1/images", 403},
		{"pcx_bob_in", "POST", "/api/v1/images/import", 403},
		{"pcx_bob_read", "GET", "/api/v1/export.zip", 403},
	})
}

// Move brings Alice's pictures to Bob: the zip adds the originals with their
// edits and versions once, and nothing of one person shows up for the other.
func TestMoveImportsAddOnce(t *testing.T) {
	a := newMoveApp(t)
	code, up := a.upload(a.alice, "red.png", testPNG(40, 30, color.RGBA{200, 20, 20, 255}))
	if code != 201 {
		t.Fatalf("upload %d %v", code, up)
	}
	p := "/api/v1/images/" + strconv.Itoa(int(num(up, "id")))
	a.expect(200, a.alice, "PUT", p, map[string]any{"title": "Red barn", "recipe": map[string]any{"v": 1, "adjust": map[string]any{"exposure": 20}}})
	a.expect(201, a.alice, "POST", p+"/versions", map[string]any{"name": "Brighter", "recipe": map[string]any{"adjust": map[string]any{"exposure": 40}}})
	a.upload(a.alice, "blue.png", testPNG(30, 30, color.RGBA{20, 20, 200, 255}))

	dump := a.moveExport("pcx_alice_out", "/api/v1/export.zip")
	if b := a.moveExport("pcx_bob_out", "/api/v1/export.zip"); strings.Contains(string(b), "Red barn") {
		t.Fatal("bob's export holds alice's pictures")
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "photolab.zip")
	_, _ = fw.Write(dump)
	_ = mw.Close()
	first := a.moveImport("pcx_bob_in", "/api/v1/import", mw.FormDataContentType(), buf.Bytes())
	second := a.moveImport("pcx_bob_in", "/api/v1/import", mw.FormDataContentType(), buf.Bytes())
	if num(first, "pictures added") != 2 || num(first, "versions") != 1 || num(first, "pictures not here") != 0 {
		t.Fatalf("first import: %v", first)
	}
	for k, v := range second {
		if n, ok := v.(float64); ok && n != 0 {
			t.Fatalf("second import added %s: %v", k, second)
		}
	}
	_, m, _ := a.call(a.bob, "GET", "/api/v1/images", nil)
	items, _ := m["items"].([]any)
	if len(items) != 2 || !strings.Contains(fmt.Sprint(items), "Red barn") {
		t.Fatalf("bob's pictures: %v", m)
	}
	_, m, _ = a.call(a.alice, "GET", "/api/v1/images", nil)
	if items, _ := m["items"].([]any); len(items) != 2 {
		t.Fatalf("alice's pictures: %v", m)
	}
}
