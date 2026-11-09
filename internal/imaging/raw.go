package imaging

import (
	"bytes"
	"image"
	"image/jpeg"
	"path"
	"strings"
)

// RAW camera files can't be developed in the browser, but nearly every one
// carries a full-size JPEG the camera made from it. The lab uses that.

var rawExts = map[string]bool{".dng": true, ".cr2": true, ".cr3": true, ".nef": true, ".nrw": true, ".arw": true, ".srf": true, ".sr2": true, ".orf": true,
	".rw2": true, ".raf": true, ".pef": true, ".srw": true, ".x3f": true, ".3fr": true, ".erf": true, ".kdc": true, ".mrw": true, ".iiq": true, ".rwl": true}

// IsRaw tells a camera RAW file by its name.
func IsRaw(name string) bool { return rawExts[strings.ToLower(path.Ext(name))] }

// RawPreview finds the largest JPEG inside a RAW file and turns it the way
// the camera said (orientation from the RAW's own TIFF header, when it has one).
func RawPreview(data []byte) ([]byte, error) {
	best, bestArea := []byte(nil), 0
	tried := 0
	for i := 0; i+4 < len(data) && tried < 64; i++ {
		if data[i] != 0xFF || data[i+1] != 0xD8 || data[i+2] != 0xFF {
			continue
		}
		tried++
		end := jpegEnd(data, i)
		if end < 0 {
			continue
		}
		cfg, err := jpeg.DecodeConfig(bytes.NewReader(data[i:end]))
		if err != nil {
			continue
		}
		if cfg.Width*cfg.Height > bestArea {
			if _, err := jpeg.Decode(bytes.NewReader(data[i:end])); err == nil {
				best, bestArea = data[i:end], cfg.Width*cfg.Height
			}
		}
		i = end - 1
	}
	if best == nil || bestArea < 160*120 {
		return nil, ErrUnsupported
	}
	o := 1
	if len(data) > 8 && (string(data[:4]) == "II*\x00" || string(data[:4]) == "MM\x00*") {
		o, _, _, _ = parseTIFF(data)
	}
	if eo, _ := jpegExif(best); eo > 1 || o <= 1 {
		return append([]byte(nil), best...), nil
	}
	img, err := jpeg.Decode(bytes.NewReader(best))
	if err != nil {
		return nil, ErrUnsupported
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, orient(img, o).(*image.RGBA), &jpeg.Options{Quality: 95}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// jpegEnd walks a JPEG's markers from its SOI at start and answers where it
// ends (just after EOI), or -1. Segments with a length (EXIF with its own
// thumbnail inside) are skipped whole.
func jpegEnd(d []byte, start int) int {
	i := start + 2
	for i+4 <= len(d) {
		if d[i] != 0xFF {
			return -1
		}
		m := d[i+1]
		switch {
		case m == 0xFF:
			i++
			continue
		case m == 0xD9:
			return i + 2
		case m == 0x01 || (m >= 0xD0 && m <= 0xD7):
			i += 2
			continue
		}
		l := int(d[i+2])<<8 | int(d[i+3])
		if l < 2 || i+2+l > len(d) {
			return -1
		}
		i += 2 + l
		if m == 0xDA { // scan data: up to the next real marker
			for i+1 < len(d) {
				if d[i] == 0xFF && d[i+1] != 0x00 && !(d[i+1] >= 0xD0 && d[i+1] <= 0xD7) && d[i+1] != 0xFF {
					break
				}
				i++
			}
		}
	}
	return -1
}
