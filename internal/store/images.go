package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
)

const imageCols = `id, user_id, title, file, mime, width, height, bytes, sha256, source, source_ref, source_name, recipe, edited, preview,
	favorite, note, taken_at, exports, last_export_at, edited_at, created_at, updated_at, camera, stale,
	(SELECT COUNT(1) FROM versions v WHERE v.image_id = images.id)`

func scanImage(sc interface{ Scan(...any) error }) (*Image, error) {
	var im Image
	var recipe string
	if err := sc.Scan(&im.ID, &im.UserID, &im.Title, &im.File, &im.Mime, &im.Width, &im.Height, &im.Bytes, &im.SHA256, &im.Source, &im.SourceRef, &im.SourceName,
		&recipe, &im.Edited, &im.Preview, &im.Favorite, &im.Note, &im.TakenAt, &im.Exports, &im.LastExportAt, &im.EditedAt, &im.CreatedAt, &im.UpdatedAt, &im.Camera, &im.Stale, &im.Versions); err != nil {
		return nil, err
	}
	im.Recipe = rawJSON(recipe)
	im.HasPreview = im.Preview != ""
	return &im, nil
}

func rawJSON(s string) json.RawMessage {
	if s == "" || !json.Valid([]byte(s)) {
		return json.RawMessage(`{}`)
	}
	return json.RawMessage(s)
}

// CreateImage adds a picture whose original is already on disk.
func (s *Store) CreateImage(ctx context.Context, uid int64, im *Image, thumb []byte) error {
	if len(im.Recipe) == 0 {
		im.Recipe = json.RawMessage(`{}`)
	}
	now := Now()
	res, err := s.DB.ExecContext(ctx, `INSERT INTO images (user_id, title, file, mime, width, height, bytes, sha256, source, source_ref, source_name, recipe, edited, preview, thumb, favorite, note, taken_at, edited_at, created_at, updated_at, camera, stale)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		uid, im.Title, im.File, im.Mime, im.Width, im.Height, im.Bytes, im.SHA256, im.Source, im.SourceRef, im.SourceName, string(im.Recipe), boolInt(im.Edited), im.Preview, thumb,
		boolInt(im.Favorite), im.Note, im.TakenAt, im.EditedAt, now, now, im.Camera, boolInt(im.Stale))
	if err != nil {
		return err
	}
	im.ID, _ = res.LastInsertId()
	im.UserID, im.CreatedAt, im.UpdatedAt = uid, now, now
	im.HasPreview = im.Preview != ""
	return nil
}

// GetImage returns one of a person's pictures.
func (s *Store) GetImage(ctx context.Context, uid, id int64) (*Image, error) {
	im, err := scanImage(s.DB.QueryRowContext(ctx, `SELECT `+imageCols+` FROM images WHERE user_id = ? AND id = ?`, uid, id))
	return im, notFound(err)
}

// FindImage returns a person's picture that came from the same place, or with the same bytes.
func (s *Store) FindImage(ctx context.Context, uid int64, source, ref, sha string) (*Image, error) {
	q, args := `SELECT `+imageCols+` FROM images WHERE user_id = ? AND source = ? AND source_ref = ? AND source_ref != '' ORDER BY id LIMIT 1`, []any{uid, source, ref}
	if ref == "" {
		q, args = `SELECT `+imageCols+` FROM images WHERE user_id = ? AND sha256 = ? AND sha256 != '' ORDER BY id LIMIT 1`, []any{uid, sha}
	}
	im, err := scanImage(s.DB.QueryRowContext(ctx, q, args...))
	return im, notFound(err)
}

// ImageFilter narrows the library.
type ImageFilter struct {
	Q      string
	Show   string // all | edited | unedited | favorites | photos | files | upload
	Sort   string // recent | added | title | taken | size
	Limit  int
	Offset int
}

// ListImages returns a page of a person's pictures and how many match.
func (s *Store) ListImages(ctx context.Context, uid int64, f ImageFilter) ([]Image, int, error) {
	where := []string{"user_id = ?"}
	args := []any{uid}
	if q := strings.TrimSpace(f.Q); q != "" {
		where = append(where, "(title LIKE ? OR source_name LIKE ? OR note LIKE ?)")
		like := "%" + q + "%"
		args = append(args, like, like, like)
	}
	switch f.Show {
	case "edited":
		where = append(where, "edited = 1")
	case "unedited":
		where = append(where, "edited = 0")
	case "favorites":
		where = append(where, "favorite = 1")
	case "stale":
		where = append(where, "stale = 1")
	case "photos", "files", "upload", "collage", "copy":
		where = append(where, "source = ?")
		args = append(args, f.Show)
	}
	w := strings.Join(where, " AND ")
	var total int
	if err := s.DB.QueryRowContext(ctx, `SELECT COUNT(1) FROM images WHERE `+w, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	order := "updated_at DESC, id DESC"
	switch f.Sort {
	case "added":
		order = "created_at DESC, id DESC"
	case "title":
		order = "title COLLATE NOCASE, id"
	case "taken":
		order = "CASE WHEN taken_at = '' THEN created_at ELSE taken_at END DESC, id DESC"
	case "size":
		order = "width * height DESC, id DESC"
	}
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 200
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT `+imageCols+` FROM images WHERE `+w+` ORDER BY `+order+` LIMIT ? OFFSET ?`, append(args, f.Limit, f.Offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []Image{}
	for rows.Next() {
		im, err := scanImage(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, *im)
	}
	return out, total, rows.Err()
}

// UpdateImage saves the title, note, favourite and the edit.
func (s *Store) UpdateImage(ctx context.Context, uid int64, im *Image) error {
	now := Now()
	res, err := s.DB.ExecContext(ctx, `UPDATE images SET title = ?, note = ?, favorite = ?, recipe = ?, edited = ?, edited_at = ?, stale = ?, updated_at = ? WHERE user_id = ? AND id = ?`,
		im.Title, im.Note, boolInt(im.Favorite), string(im.Recipe), boolInt(im.Edited), im.EditedAt, boolInt(im.Stale), now, uid, im.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	im.UpdatedAt = now
	return nil
}

// SetImageLook stores the rendered preview file and thumbnail of the current edit.
func (s *Store) SetImageLook(ctx context.Context, uid, id int64, preview string, thumb []byte) error {
	res, err := s.DB.ExecContext(ctx, `UPDATE images SET preview = ?, thumb = ?, stale = 0 WHERE user_id = ? AND id = ?`, preview, thumb, uid, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ImageThumb returns the small JPEG of a picture's current look.
func (s *Store) ImageThumb(ctx context.Context, uid, id int64) ([]byte, string, error) {
	var b []byte
	var at string
	err := s.DB.QueryRowContext(ctx, `SELECT thumb, updated_at FROM images WHERE user_id = ? AND id = ?`, uid, id).Scan(&b, &at)
	return b, at, notFound(err)
}

// DeleteImage removes a picture and returns it, so its files can go too.
func (s *Store) DeleteImage(ctx context.Context, uid, id int64) (*Image, error) {
	im, err := s.GetImage(ctx, uid, id)
	if err != nil {
		return nil, err
	}
	if _, err := s.DB.ExecContext(ctx, `DELETE FROM images WHERE user_id = ? AND id = ?`, uid, id); err != nil {
		return nil, err
	}
	return im, nil
}

// FileUsers counts the pictures that still point at a file (copies share the original).
func (s *Store) FileUsers(ctx context.Context, file string) int {
	var n int
	_ = s.DB.QueryRowContext(ctx, `SELECT COUNT(1) FROM images WHERE file = ? OR preview = ?`, file, file).Scan(&n)
	return n
}

// ImageBytes is the room a person's originals take.
func (s *Store) ImageBytes(ctx context.Context, uid int64) int64 {
	var n sql.NullInt64
	_ = s.DB.QueryRowContext(ctx, `SELECT SUM(bytes) FROM images WHERE user_id = ?`, uid).Scan(&n)
	return n.Int64
}

// ---- versions ----

// CreateVersion saves a state of an edit.
func (s *Store) CreateVersion(ctx context.Context, uid int64, v *Version, thumb []byte) error {
	if _, err := s.GetImage(ctx, uid, v.ImageID); err != nil {
		return err
	}
	now := Now()
	res, err := s.DB.ExecContext(ctx, `INSERT INTO versions (user_id, image_id, name, recipe, thumb, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		uid, v.ImageID, v.Name, string(v.Recipe), thumb, now)
	if err != nil {
		return err
	}
	v.ID, _ = res.LastInsertId()
	v.CreatedAt, v.HasThumb = now, len(thumb) > 0
	return nil
}

// ListVersions returns a picture's saved states, newest first.
func (s *Store) ListVersions(ctx context.Context, uid, imageID int64) ([]Version, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id, image_id, name, recipe, thumb IS NOT NULL, created_at FROM versions WHERE user_id = ? AND image_id = ? ORDER BY id DESC`, uid, imageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Version{}
	for rows.Next() {
		var v Version
		var recipe string
		if err := rows.Scan(&v.ID, &v.ImageID, &v.Name, &recipe, &v.HasThumb, &v.CreatedAt); err != nil {
			return nil, err
		}
		v.Recipe = rawJSON(recipe)
		out = append(out, v)
	}
	return out, rows.Err()
}

// VersionThumb returns a saved state's thumbnail.
func (s *Store) VersionThumb(ctx context.Context, uid, id int64) ([]byte, error) {
	var b []byte
	err := s.DB.QueryRowContext(ctx, `SELECT thumb FROM versions WHERE user_id = ? AND id = ?`, uid, id).Scan(&b)
	return b, notFound(err)
}

// DeleteVersion removes a saved state.
func (s *Store) DeleteVersion(ctx context.Context, uid, id int64) error {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM versions WHERE user_id = ? AND id = ?`, uid, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- presets ----

// ListPresets returns a person's own looks.
func (s *Store) ListPresets(ctx context.Context, uid int64) ([]Preset, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id, name, recipe, thumb IS NOT NULL, sort, created_at, updated_at FROM presets WHERE user_id = ? ORDER BY sort, name COLLATE NOCASE`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Preset{}
	for rows.Next() {
		var p Preset
		var recipe string
		if err := rows.Scan(&p.ID, &p.Name, &recipe, &p.HasThumb, &p.Sort, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		p.Recipe = rawJSON(recipe)
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetPreset returns one of a person's looks.
func (s *Store) GetPreset(ctx context.Context, uid, id int64) (*Preset, error) {
	var p Preset
	var recipe string
	err := s.DB.QueryRowContext(ctx, `SELECT id, name, recipe, thumb IS NOT NULL, sort, created_at, updated_at FROM presets WHERE user_id = ? AND id = ?`, uid, id).
		Scan(&p.ID, &p.Name, &recipe, &p.HasThumb, &p.Sort, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, notFound(err)
	}
	p.Recipe = rawJSON(recipe)
	return &p, nil
}

// CreatePreset saves a look; a name already used is a conflict.
func (s *Store) CreatePreset(ctx context.Context, uid int64, p *Preset, thumb []byte) error {
	now := Now()
	res, err := s.DB.ExecContext(ctx, `INSERT INTO presets (user_id, name, recipe, thumb, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		uid, p.Name, string(p.Recipe), thumb, p.Sort, now, now)
	if err != nil {
		return conflict(err)
	}
	p.ID, _ = res.LastInsertId()
	p.CreatedAt, p.UpdatedAt, p.HasThumb = now, now, len(thumb) > 0
	return nil
}

// UpdatePreset renames, reorders or changes a look (thumb nil keeps the old one).
func (s *Store) UpdatePreset(ctx context.Context, uid int64, p *Preset, thumb []byte) error {
	now := Now()
	q, args := `UPDATE presets SET name = ?, recipe = ?, sort = ?, updated_at = ? WHERE user_id = ? AND id = ?`, []any{p.Name, string(p.Recipe), p.Sort, now, uid, p.ID}
	if thumb != nil {
		q, args = `UPDATE presets SET name = ?, recipe = ?, sort = ?, thumb = ?, updated_at = ? WHERE user_id = ? AND id = ?`, []any{p.Name, string(p.Recipe), p.Sort, thumb, now, uid, p.ID}
	}
	res, err := s.DB.ExecContext(ctx, q, args...)
	if err != nil {
		return conflict(err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	p.UpdatedAt = now
	return nil
}

// PresetThumb returns a look's sample thumbnail.
func (s *Store) PresetThumb(ctx context.Context, uid, id int64) ([]byte, error) {
	var b []byte
	err := s.DB.QueryRowContext(ctx, `SELECT thumb FROM presets WHERE user_id = ? AND id = ?`, uid, id).Scan(&b)
	return b, notFound(err)
}

// DeletePreset removes a look.
func (s *Store) DeletePreset(ctx context.Context, uid, id int64) error {
	res, err := s.DB.ExecContext(ctx, `DELETE FROM presets WHERE user_id = ? AND id = ?`, uid, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- exports ----

// CreateExport records a picture that left the lab and counts it on the picture.
func (s *Store) CreateExport(ctx context.Context, uid int64, e *Export) error {
	if e.ImageID != nil {
		if _, err := s.GetImage(ctx, uid, *e.ImageID); err != nil {
			return err
		}
	}
	now := Now()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO exports (user_id, image_id, title, format, width, height, bytes, destination, target, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		uid, nullI(e.ImageID), e.Title, e.Format, e.Width, e.Height, e.Bytes, e.Destination, e.Target, now)
	if err != nil {
		_ = tx.Rollback()
		return err
	}
	if e.ImageID != nil {
		if _, err := tx.ExecContext(ctx, `UPDATE images SET exports = exports + 1, last_export_at = ? WHERE user_id = ? AND id = ?`, now, uid, *e.ImageID); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	e.ID, _ = res.LastInsertId()
	e.CreatedAt = now
	return nil
}

// ListExports returns a person's latest exports.
func (s *Store) ListExports(ctx context.Context, uid int64, limit int) ([]Export, error) {
	if limit <= 0 || limit > 1000 {
		limit = 50
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT id, image_id, title, format, width, height, bytes, destination, target, created_at FROM exports WHERE user_id = ? ORDER BY id DESC LIMIT ?`, uid, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Export{}
	for rows.Next() {
		var e Export
		var img sql.NullInt64
		if err := rows.Scan(&e.ID, &img, &e.Title, &e.Format, &e.Width, &e.Height, &e.Bytes, &e.Destination, &e.Target, &e.CreatedAt); err != nil {
			return nil, err
		}
		if img.Valid {
			v := img.Int64
			e.ImageID = &v
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// Stats are a person's totals for the home page.
type Stats struct {
	Images    int   `json:"images"`
	Edited    int   `json:"edited"`
	Favorites int   `json:"favorites"`
	Presets   int   `json:"presets"`
	Exports   int   `json:"exports"`
	Bytes     int64 `json:"bytes"`
}

// StatsFor counts a person's pictures, looks and exports.
func (s *Store) StatsFor(ctx context.Context, uid int64) Stats {
	var st Stats
	_ = s.DB.QueryRowContext(ctx, `SELECT COUNT(1), COALESCE(SUM(edited), 0), COALESCE(SUM(favorite), 0), COALESCE(SUM(bytes), 0) FROM images WHERE user_id = ?`, uid).
		Scan(&st.Images, &st.Edited, &st.Favorites, &st.Bytes)
	_ = s.DB.QueryRowContext(ctx, `SELECT COUNT(1) FROM presets WHERE user_id = ?`, uid).Scan(&st.Presets)
	_ = s.DB.QueryRowContext(ctx, `SELECT COUNT(1) FROM exports WHERE user_id = ?`, uid).Scan(&st.Exports)
	return st
}

// ---- fonts ----

// Font is a typeface of one's own for text on pictures.
type Font struct {
	ID        int64  `json:"id"`
	UserID    int64  `json:"-"`
	Name      string `json:"name"`
	File      string `json:"-"`
	Mime      string `json:"mime"`
	Bytes     int64  `json:"bytes"`
	CreatedAt string `json:"created_at"`
}

// CreateFont saves a font whose file is already on disk.
func (s *Store) CreateFont(ctx context.Context, uid int64, f *Font) error {
	now := Now()
	res, err := s.DB.ExecContext(ctx, `INSERT INTO fonts (user_id, name, file, mime, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)`, uid, f.Name, f.File, f.Mime, f.Bytes, now)
	if err != nil {
		return err
	}
	f.ID, _ = res.LastInsertId()
	f.UserID, f.CreatedAt = uid, now
	return nil
}

// ListFonts returns a person's fonts.
func (s *Store) ListFonts(ctx context.Context, uid int64) ([]Font, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id, name, file, mime, bytes, created_at FROM fonts WHERE user_id = ? ORDER BY name COLLATE NOCASE`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Font{}
	for rows.Next() {
		var f Font
		if err := rows.Scan(&f.ID, &f.Name, &f.File, &f.Mime, &f.Bytes, &f.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// GetFont returns one of a person's fonts.
func (s *Store) GetFont(ctx context.Context, uid, id int64) (*Font, error) {
	var f Font
	err := s.DB.QueryRowContext(ctx, `SELECT id, name, file, mime, bytes, created_at FROM fonts WHERE user_id = ? AND id = ?`, uid, id).Scan(&f.ID, &f.Name, &f.File, &f.Mime, &f.Bytes, &f.CreatedAt)
	return &f, notFound(err)
}

// DeleteFont removes a font and returns it (for its file).
func (s *Store) DeleteFont(ctx context.Context, uid, id int64) (*Font, error) {
	f, err := s.GetFont(ctx, uid, id)
	if err != nil {
		return nil, err
	}
	_, err = s.DB.ExecContext(ctx, `DELETE FROM fonts WHERE user_id = ? AND id = ?`, uid, id)
	return f, err
}
