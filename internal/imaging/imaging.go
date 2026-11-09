// Package imaging reads pictures on the server: what kind they are, how big,
// which way up the camera meant them, when they were taken, and makes the
// small JPEG thumbnails the library shows. Editing itself happens in the
// browser; nothing here ever changes an original.
package imaging

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/jpeg"
	"image/png"
	"net/http"
	"strings"

	xdraw "golang.org/x/image/draw"

	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

// ErrUnsupported is a file that is not a picture the lab can open.
var ErrUnsupported = errors.New("not a picture the lab can open (JPEG, PNG, WebP, GIF, AVIF, BMP or TIFF)")

// Info describes a picture as it should be seen (the camera's rotation applied).
type Info struct {
	Mime        string
	Width       int
	Height      int
	Orientation int    // EXIF 1–8, 1 = as stored
	TakenAt     string // from EXIF, "2006-01-02T15:04:05", "" when unknown
	Camera      string // "Make Model" from EXIF
	Decodable   bool   // the server can read the pixels (and so make a thumbnail)
}

// Sniff tells the kind of picture from its first bytes.
func Sniff(data []byte) string {
	if len(data) >= 12 {
		switch {
		case string(data[4:8]) == "ftyp":
			brand := string(data[8:12])
			switch brand {
			case "avif", "avis":
				return "image/avif"
			case "heic", "heix", "hevc", "heim", "heis", "mif1", "msf1":
				return "image/heic"
			}
		case string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
			return "image/webp"
		}
	}
	m := http.DetectContentType(data)
	if i := strings.IndexByte(m, ';'); i > 0 {
		m = m[:i]
	}
	switch m {
	case "image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp":
		return m
	}
	if len(data) > 4 && (string(data[:4]) == "II*\x00" || string(data[:4]) == "MM\x00*") {
		return "image/tiff"
	}
	return ""
}

// Browser reports whether every current browser opens this kind itself.
func Browser(mime string) bool {
	switch mime {
	case "image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/bmp":
		return true
	}
	return false
}

// Ext is the file extension for a kind of picture.
func Ext(mime string) string {
	switch mime {
	case "image/jpeg":
		return ".jpg"
	case "image/png":
		return ".png"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/avif":
		return ".avif"
	case "image/bmp":
		return ".bmp"
	case "image/tiff":
		return ".tif"
	case "image/heic":
		return ".heic"
	}
	return ".bin"
}

// Probe reads the size, kind, rotation and date of a picture without
// decoding all of it.
func Probe(data []byte) (Info, error) {
	in := Info{Mime: Sniff(data), Orientation: 1}
	if in.Mime == "" {
		return in, ErrUnsupported
	}
	if in.Mime == "image/jpeg" {
		var mk, md string
		in.Orientation, in.TakenAt, mk, md = jpegExifAll(data)
		in.Camera = cameraName(mk, md)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err == nil {
		in.Width, in.Height, in.Decodable = cfg.Width, cfg.Height, true
	} else if in.Mime == "image/avif" || in.Mime == "image/heic" {
		in.Width, in.Height = ispeSize(data)
	} else {
		return in, ErrUnsupported
	}
	if in.Orientation >= 5 && in.Orientation <= 8 {
		in.Width, in.Height = in.Height, in.Width
	}
	return in, nil
}

// Decode reads the pixels with the camera's rotation applied.
func Decode(data []byte) (image.Image, error) {
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, ErrUnsupported
	}
	if Sniff(data) == "image/jpeg" {
		if o, _ := jpegExif(data); o > 1 {
			img = orient(img, o)
		}
	}
	return img, nil
}

// Thumb is a JPEG at most max pixels on its long edge.
func Thumb(img image.Image, max int, quality int) ([]byte, error) {
	small := Fit(img, max)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, flatten(small), &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// PNG encodes a picture losslessly (used for TIFF originals, which browsers can't open).
func PNG(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	err := enc.Encode(&buf, img)
	return buf.Bytes(), err
}

// FirstFrame of an animated GIF is what the lab edits.
func FirstFrame(data []byte) image.Image {
	g, err := gif.DecodeAll(bytes.NewReader(data))
	if err != nil || len(g.Image) == 0 {
		return nil
	}
	return g.Image[0]
}

// Fit scales a picture down (never up) to max pixels on its long edge:
// halving with a box filter first, then Catmull-Rom, so big photos stay
// fast and small ones sharp.
func Fit(img image.Image, max int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if max <= 0 || (w <= max && h <= max) {
		return img
	}
	src := toRGBA(img)
	for src.Bounds().Dx() >= 2*max*2 || src.Bounds().Dy() >= 2*max*2 {
		src = halve(src)
	}
	w, h = src.Bounds().Dx(), src.Bounds().Dy()
	tw, th := max, h*max/w
	if h > w {
		tw, th = w*max/h, max
	}
	if tw < 1 {
		tw = 1
	}
	if th < 1 {
		th = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Src, nil)
	return dst
}

func toRGBA(img image.Image) *image.RGBA {
	if r, ok := img.(*image.RGBA); ok && r.Bounds().Min == (image.Point{}) {
		return r
	}
	b := img.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), img, b.Min, draw.Src)
	return dst
}

// halve averages 2×2 blocks.
func halve(src *image.RGBA) *image.RGBA {
	w, h := src.Bounds().Dx()/2, src.Bounds().Dy()/2
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	sp, dp := src.Pix, dst.Pix
	ss := src.Stride
	for y := 0; y < h; y++ {
		r0 := 2 * y * ss
		r1 := r0 + ss
		o := y * dst.Stride
		for x := 0; x < w; x++ {
			i := 8 * x
			for c := 0; c < 4; c++ {
				dp[o+4*x+c] = uint8((int(sp[r0+i+c]) + int(sp[r0+i+4+c]) + int(sp[r1+i+c]) + int(sp[r1+i+4+c]) + 2) / 4)
			}
		}
	}
	return dst
}

// flatten puts transparent pictures on white (JPEG has no transparency).
func flatten(img image.Image) image.Image {
	b := img.Bounds()
	dst := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(dst, dst.Bounds(), &image.Uniform{color.White}, image.Point{}, draw.Src)
	draw.Draw(dst, dst.Bounds(), img, b.Min, draw.Over)
	return dst
}

// orient turns stored pixels the way EXIF orientation o says to show them.
func orient(img image.Image, o int) image.Image {
	src := toRGBA(img)
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch o {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			default:
				dx, dy = x, y
			}
			si := y*src.Stride + 4*x
			di := dy*dst.Stride + 4*dx
			copy(dst.Pix[di:di+4], src.Pix[si:si+4])
		}
	}
	return dst
}

// cameraName joins make and model without repeating the brand ("Apple iPhone 15", not "Apple Apple iPhone 15").
func cameraName(mk, md string) string {
	mk, md = strings.TrimSpace(mk), strings.TrimSpace(md)
	if mk == "" || strings.HasPrefix(strings.ToLower(md), strings.ToLower(strings.Fields(mk + " x")[0])) {
		return md
	}
	if md == "" {
		return mk
	}
	return mk + " " + md
}

// CameraName is cameraName for callers outside (Pocket Photos' EXIF).
func CameraName(mk, md string) string { return cameraName(mk, md) }
