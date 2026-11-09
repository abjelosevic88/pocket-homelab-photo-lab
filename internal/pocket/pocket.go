// Package pocket talks to sibling Pocket apps: Pocket Photos (the person's
// library, through its Immich routes) and Pocket Files. Same bearer-token API
// everywhere; pictures travel as raw bytes.
package pocket

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"time"
)

// Client is a bearer-token JSON client for one Pocket app.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// New creates a client.
func New(baseURL, token string, timeout time.Duration) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), Token: token, HTTP: &http.Client{Timeout: timeout}}
}

// Configured reports whether URL and token are set.
func (c *Client) Configured() bool { return c != nil && c.BaseURL != "" && c.Token != "" }

// ErrNotFound is a 404 from the sibling app.
var ErrNotFound = errors.New("not found")

func (c *Client) do(ctx context.Context, method, path string, q url.Values, body any, v any) error {
	if !c.Configured() {
		return errors.New("not configured")
	}
	u := c.BaseURL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		return errors.New("token rejected (401)")
	}
	if res.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	if res.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		b, _ := io.ReadAll(io.LimitReader(res.Body, 2000))
		_ = json.Unmarshal(b, &e)
		if e.Error != "" {
			return fmt.Errorf("HTTP %d: %s", res.StatusCode, e.Error)
		}
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	if v == nil || res.StatusCode == http.StatusNoContent {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(v)
}

// Health is the connection test for any Pocket app: /healthz plus a token check.
func (c *Client) Health(ctx context.Context) (string, error) {
	var out struct {
		Status  string `json:"status"`
		Version string `json:"version"`
	}
	if !c.Configured() {
		return "", errors.New("not configured")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/healthz", nil)
	if err != nil {
		return "", err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", res.StatusCode)
	}
	_ = json.NewDecoder(res.Body).Decode(&out)
	var me map[string]any
	if err := c.do(ctx, http.MethodGet, "/api/v1/auth/me", nil, nil, &me); err != nil {
		return out.Version, err
	}
	return out.Version, nil
}

// Do sends a request and hands back the response for the caller to read
// (pictures). Non-2xx answers are turned into errors.
func (c *Client) Do(ctx context.Context, method, path string, q url.Values, body io.Reader, contentType string) (*http.Response, error) {
	if !c.Configured() {
		return nil, errors.New("not configured")
	}
	u := c.BaseURL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		defer res.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(res.Body, 2000))
		var e struct {
			Error   string `json:"error"`
			Message any    `json:"message"`
		}
		_ = json.Unmarshal(b, &e)
		switch {
		case res.StatusCode == http.StatusUnauthorized:
			return nil, errors.New("token rejected (401)")
		case res.StatusCode == http.StatusNotFound && e.Error == "":
			return nil, ErrNotFound
		case e.Error != "":
			return nil, fmt.Errorf("HTTP %d: %s", res.StatusCode, e.Error)
		case e.Message != nil:
			return nil, fmt.Errorf("HTTP %d: %v", res.StatusCode, e.Message)
		}
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return res, nil
}

// JSON calls a JSON endpoint (exported form of do).
func (c *Client) JSON(ctx context.Context, method, path string, q url.Values, body any, v any) error {
	return c.do(ctx, method, path, q, body, v)
}

// ---------------- Pocket Photos (Immich through it) ----------------

// Asset is a photo in the person's library.
type Asset struct {
	ID               string `json:"id"`
	Type             string `json:"type"`
	OriginalFileName string `json:"originalFileName"`
	OriginalMimeType string `json:"originalMimeType"`
	FileCreatedAt    string `json:"fileCreatedAt"`
	LocalDateTime    string `json:"localDateTime"`
	IsFavorite       bool   `json:"isFavorite"`
	Width            int    `json:"width"`
	Height           int    `json:"height"`
	ExifInfo         *struct {
		ExifImageWidth  int    `json:"exifImageWidth"`
		ExifImageHeight int    `json:"exifImageHeight"`
		Orientation     any    `json:"orientation"`
		Make            string `json:"make"`
		Model           string `json:"model"`
		City            string `json:"city"`
		Country         string `json:"country"`
		Description     string `json:"description"`
	} `json:"exifInfo,omitempty"`
}

// SearchPhotos lists pictures, newest first, or the best matches for a
// description when query is set. cursor/page continue a listing.
func (c *Client) SearchPhotos(ctx context.Context, query, cursor string, size int, favorites bool) ([]Asset, string, error) {
	body := map[string]any{"type": "IMAGE", "size": size, "withExif": true}
	path := "/api/v1/immich/search/metadata"
	if query != "" {
		path = "/api/v1/immich/search/smart"
		body["query"] = query
	} else {
		body["orderBy"] = map[string]string{"field": "fileCreatedAt", "direction": "desc"}
		if cursor != "" {
			if len(cursor) < 6 {
				body["page"] = cursor
			} else {
				body["cursor"] = cursor
			}
		}
	}
	if favorites {
		body["isFavorite"] = true
	}
	var out struct {
		Assets struct {
			Items      []Asset `json:"items"`
			NextCursor *string `json:"nextCursor"`
			NextPage   *string `json:"nextPage"`
		} `json:"assets"`
	}
	if err := c.do(ctx, http.MethodPost, path, nil, body, &out); err != nil {
		return nil, "", err
	}
	next := ""
	if out.Assets.NextCursor != nil {
		next = *out.Assets.NextCursor
	} else if out.Assets.NextPage != nil {
		next = *out.Assets.NextPage
	}
	if out.Assets.Items == nil {
		out.Assets.Items = []Asset{}
	}
	return out.Assets.Items, next, nil
}

// Asset returns one photo's details.
func (c *Client) Asset(ctx context.Context, id string) (*Asset, error) {
	var a Asset
	if err := c.do(ctx, http.MethodGet, "/api/v1/immich/assets/"+url.PathEscape(id), nil, nil, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

// UploadPhoto adds a picture to the person's library as a new photo.
func (c *Client) UploadPhoto(ctx context.Context, name, mime string, data []byte, created time.Time) (string, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	ts := created.UTC().Format(time.RFC3339)
	for k, v := range map[string]string{"deviceAssetId": fmt.Sprintf("pocket-photolab-%s-%d", name, time.Now().UnixNano()), "deviceId": "pocket-photolab", "fileCreatedAt": ts, "fileModifiedAt": ts, "filename": name} {
		_ = mw.WriteField(k, v)
	}
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="assetData"; filename=%q`, name))
	h.Set("Content-Type", mime)
	fw, err := mw.CreatePart(h)
	if err != nil {
		return "", err
	}
	if _, err := fw.Write(data); err != nil {
		return "", err
	}
	if err := mw.Close(); err != nil {
		return "", err
	}
	res, err := c.Do(ctx, http.MethodPost, "/api/v1/immich/assets", nil, &buf, mw.FormDataContentType())
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var out struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out)
	return out.ID, nil
}

// ---------------- Pocket Files ----------------

// Space is a place in Pocket Files (My files, a mount, a share).
type Space struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Perm     string `json:"perm"`
	ReadOnly bool   `json:"read_only,omitempty"`
}

// Entry is a file or folder in Pocket Files.
type Entry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	IsDir    bool   `json:"is_dir"`
	Size     int64  `json:"size"`
	Modified string `json:"modified"`
	Mime     string `json:"mime"`
}

// Spaces lists the person's places in Pocket Files.
func (c *Client) Spaces(ctx context.Context) ([]Space, error) {
	var out []Space
	err := c.do(ctx, http.MethodGet, "/api/v1/spaces", nil, nil, &out)
	return out, err
}

// List lists a folder.
func (c *Client) List(ctx context.Context, space, path string) ([]Entry, error) {
	var out struct {
		Entries []Entry `json:"entries"`
	}
	err := c.do(ctx, http.MethodGet, "/api/v1/fs/list", url.Values{"space": {space}, "path": {path}}, nil, &out)
	if out.Entries == nil {
		out.Entries = []Entry{}
	}
	return out.Entries, err
}

// Upload saves a file into a folder (a name already there gets a new one).
func (c *Client) Upload(ctx context.Context, space, dir, name string, data []byte) (*Entry, error) {
	res, err := c.Do(ctx, http.MethodPut, "/api/v1/fs/upload", url.Values{"space": {space}, "path": {dir}, "name": {name}, "conflict": {"rename"}}, bytes.NewReader(data), "application/octet-stream")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var e Entry
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&e)
	return &e, nil
}
