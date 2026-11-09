package imaging

import (
	"os"
	"testing"
)

// The browser's EXIF writer (web/src/lib/exif.ts) is read back here when
// PLAB_EXIF_FILE points at a file it made.
func TestReadBrowserExif(t *testing.T) {
	f := os.Getenv("PLAB_EXIF_FILE")
	if f == "" {
		t.Skip("PLAB_EXIF_FILE not set")
	}
	b, err := os.ReadFile(f)
	if err != nil {
		t.Fatal(err)
	}
	o, taken, mk, md := jpegExifAll(b)
	if o != 1 || taken != "2024-06-01T18:30:05" || mk != "Apple" || md != "Apple iPhone 15 Pro" {
		t.Fatalf("got %d %q %q %q", o, taken, mk, md)
	}
	if CameraName(mk, md) != "Apple iPhone 15 Pro" {
		t.Fatalf("camera %q", CameraName(mk, md))
	}
	if _, err := Decode(b); err != nil {
		t.Fatal(err)
	}
}
