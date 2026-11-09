package store

import "encoding/json"

// User is an account on this box.
type User struct {
	ID           int64  `json:"id"`
	Email        string `json:"email"`
	Name         string `json:"name"`
	PasswordHash string `json:"-"`
	Role         string `json:"role"` // admin | member
	CreatedAt    string `json:"created_at"`
}

// APIToken is a personal access token (hash stored, plaintext shown once).
type APIToken struct {
	ID         int64   `json:"id"`
	UserID     int64   `json:"user_id"`
	Name       string  `json:"name"`
	Prefix     string  `json:"prefix"`
	LastUsedAt *string `json:"last_used_at"`
	CreatedAt  string  `json:"created_at"`
}

// Image is one picture in the lab. The original file is never changed: the
// edit is a recipe the browser applies (web/src/lib/recipe.ts).
type Image struct {
	ID           int64           `json:"id"`
	UserID       int64           `json:"-"`
	Title        string          `json:"title"`
	File         string          `json:"-"`
	Mime         string          `json:"mime"`
	Width        int             `json:"width"`
	Height       int             `json:"height"`
	Bytes        int64           `json:"bytes"`
	SHA256       string          `json:"sha256"`
	Source       string          `json:"source"`
	SourceRef    string          `json:"source_ref"`
	SourceName   string          `json:"source_name"`
	Recipe       json.RawMessage `json:"recipe"`
	Edited       bool            `json:"edited"`
	Preview      string          `json:"-"`
	HasPreview   bool            `json:"has_preview"`
	Favorite     bool            `json:"favorite"`
	Note         string          `json:"note"`
	TakenAt      string          `json:"taken_at"`
	Exports      int             `json:"exports"`
	LastExportAt string          `json:"last_export_at"`
	EditedAt     string          `json:"edited_at"`
	CreatedAt    string          `json:"created_at"`
	UpdatedAt    string          `json:"updated_at"`
	Versions     int             `json:"versions"`
	Camera       string          `json:"camera"`
	Stale        bool            `json:"stale"` // the look is behind the edit
}

// Version is a saved state of an edit.
type Version struct {
	ID        int64           `json:"id"`
	UserID    int64           `json:"-"`
	ImageID   int64           `json:"image_id"`
	Name      string          `json:"name"`
	Recipe    json.RawMessage `json:"recipe"`
	HasThumb  bool            `json:"has_thumb"`
	CreatedAt string          `json:"created_at"`
}

// Preset is a look of one's own: light, colour and effects.
type Preset struct {
	ID        int64           `json:"id"`
	UserID    int64           `json:"-"`
	Name      string          `json:"name"`
	Recipe    json.RawMessage `json:"recipe"`
	HasThumb  bool            `json:"has_thumb"`
	Sort      int             `json:"sort"`
	CreatedAt string          `json:"created_at"`
	UpdatedAt string          `json:"updated_at"`
}

// Export is a picture that left the lab.
type Export struct {
	ID          int64  `json:"id"`
	UserID      int64  `json:"-"`
	ImageID     *int64 `json:"image_id"`
	Title       string `json:"title"`
	Format      string `json:"format"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	Bytes       int64  `json:"bytes"`
	Destination string `json:"destination"`
	Target      string `json:"target"`
	CreatedAt   string `json:"created_at"`
}

// Settings are the box-wide values plus one person's preferences and their
// own connections. Connection modes: "core" (an app link through Pocket
// Core), "direct" (URL + token) or "off"; "" = not chosen yet.
type Settings struct {
	Title         string `json:"title"`
	SetupComplete bool   `json:"setup_complete"`

	DateFormat string `json:"date_format"`
	TimeFormat string `json:"time_format"`
	WeekStart  int    `json:"week_start"` // 1 = Monday, 7 = Sunday

	// Saving a picture: the format, quality and size it leaves in, its name
	// and where it goes unless chosen otherwise.
	ExportFormat  string  `json:"export_format"`   // jpeg | png | webp | avif
	ExportQuality float64 `json:"export_quality"`  // 0.5–1 for jpeg, webp, avif
	ExportMaxEdge int     `json:"export_max_edge"` // 0 = full size
	ExportName    string  `json:"export_name"`     // {title} {date} {n} {w} {h}
	SaveTo        string  `json:"save_to"`         // download | photos | files
	FilesFolder   string  `json:"files_folder"`    // in Pocket Files, "My files"

	KeepDate    bool `json:"keep_date"`    // the date taken goes into saved JPEGs
	KeepCamera  bool `json:"keep_camera"`  // and the camera's make and model
	StackPhotos bool `json:"stack_photos"` // a copy saved to Pocket Photos is stacked on its original

	// The editor.
	PreviewSize  int    `json:"preview_size"`  // the long edge the editor works on, 1200–4096
	ShowGrid     bool   `json:"show_grid"`     // thirds while cropping
	Histogram    bool   `json:"histogram"`     // live histogram under the picture
	CompareStyle string `json:"compare_style"` // hold | split
	ConfirmLeave bool   `json:"confirm_leave"` // ask before leaving with unsaved changes
	Sort         string `json:"sort"`          // the library: recent | added | title | taken

	PhotosMode      string `json:"photos_mode"`
	PhotosURL       string `json:"photos_url"`
	PhotosToken     string `json:"photos_token"`
	PhotosPublicURL string `json:"photos_public_url"`

	FilesMode      string `json:"files_mode"`
	FilesURL       string `json:"files_url"`
	FilesToken     string `json:"files_token"`
	FilesPublicURL string `json:"files_public_url"`

	BlogMode      string `json:"blog_mode"`
	BlogURL       string `json:"blog_url"`
	BlogToken     string `json:"blog_token"`
	BlogPublicURL string `json:"blog_public_url"`

	ChatMode      string `json:"chat_mode"`
	ChatURL       string `json:"chat_url"`
	ChatToken     string `json:"chat_token"`
	ChatPublicURL string `json:"chat_public_url"`

	NotesMode      string `json:"notes_mode"`
	NotesURL       string `json:"notes_url"`
	NotesToken     string `json:"notes_token"`
	NotesPublicURL string `json:"notes_public_url"`

	DocumentsMode      string `json:"documents_mode"`
	DocumentsURL       string `json:"documents_url"`
	DocumentsToken     string `json:"documents_token"`
	DocumentsPublicURL string `json:"documents_public_url"`

	// AI for "Suggest an edit" and "Describe": Pocket AI through Core, or an
	// OpenAI-compatible API with the person's own key.
	AIProvider    string `json:"ai_provider"` // auto | pocket | openai
	AIPocketModel string `json:"ai_pocket_model"`
	AIPhotos      bool   `json:"ai_photos"` // a small copy of the picture may go to the AI
	OpenAIKey     string `json:"openai_api_key"`
	OpenAIModel   string `json:"openai_model"`
	OpenAIBaseURL string `json:"openai_base_url"`
}
