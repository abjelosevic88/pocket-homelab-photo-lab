package imaging

import (
	"encoding/binary"
	"strings"
)

// jpegExif reads the orientation (tag 0x0112) and the date taken (0x9003,
// else 0x0132) from a JPEG's EXIF block. Anything unreadable gives 1 and "".
func jpegExif(data []byte) (orientation int, taken string) {
	orientation = 1
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return
	}
	i := 2
	for i+4 <= len(data) {
		if data[i] != 0xFF {
			return
		}
		marker := data[i+1]
		if marker == 0xDA || marker == 0xD9 { // image data starts: no EXIF after this
			return
		}
		size := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		if size < 2 || i+2+size > len(data) {
			return
		}
		seg := data[i+4 : i+2+size]
		if marker == 0xE1 && len(seg) > 14 && string(seg[:6]) == "Exif\x00\x00" {
			return parseTIFF(seg[6:])
		}
		i += 2 + size
	}
	return
}

func parseTIFF(t []byte) (orientation int, taken string) {
	orientation = 1
	if len(t) < 8 {
		return
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return
	}
	str := func(count, off uint32) string {
		if count < 2 || int(off)+int(count) > len(t) {
			return ""
		}
		return strings.TrimRight(string(t[off:off+count]), "\x00 ")
	}
	var exifIFD uint32
	var modified string
	readIFD := func(off uint32, fn func(tag, typ uint16, count, val uint32, raw []byte)) {
		if int(off)+2 > len(t) {
			return
		}
		n := int(bo.Uint16(t[off:]))
		for k := 0; k < n && k < 512; k++ {
			e := int(off) + 2 + 12*k
			if e+12 > len(t) {
				return
			}
			fn(bo.Uint16(t[e:]), bo.Uint16(t[e+2:]), bo.Uint32(t[e+4:]), bo.Uint32(t[e+8:]), t[e+8:e+12])
		}
	}
	readIFD(bo.Uint32(t[4:]), func(tag, typ uint16, count, val uint32, raw []byte) {
		switch tag {
		case 0x0112:
			if typ == 3 {
				if o := int(bo.Uint16(raw)); o >= 1 && o <= 8 {
					orientation = o
				}
			}
		case 0x0132:
			modified = str(count, val)
		case 0x8769:
			exifIFD = val
		}
	})
	if exifIFD > 0 {
		readIFD(exifIFD, func(tag, typ uint16, count, val uint32, raw []byte) {
			if tag == 0x9003 {
				taken = str(count, val)
			}
		})
	}
	if taken == "" {
		taken = modified
	}
	taken = exifDate(taken)
	return
}

// exifDate turns "2024:06:01 18:30:00" into "2024-06-01T18:30:00".
func exifDate(s string) string {
	if len(s) < 19 || s[4] != ':' || s[7] != ':' || s[10] != ' ' || strings.HasPrefix(s, "0000") {
		return ""
	}
	return s[0:4] + "-" + s[5:7] + "-" + s[8:10] + "T" + s[11:19]
}

// ispeSize finds the picture size of an AVIF or HEIC file (the first "ispe"
// box), which Go can't decode; 0, 0 when it isn't there.
func ispeSize(data []byte) (int, int) {
	limit := len(data)
	if limit > 1<<20 {
		limit = 1 << 20
	}
	for i := 4; i+16 <= limit; i++ {
		if data[i] == 'i' && data[i+1] == 's' && data[i+2] == 'p' && data[i+3] == 'e' {
			w := int(binary.BigEndian.Uint32(data[i+8:]))
			h := int(binary.BigEndian.Uint32(data[i+12:]))
			if w > 0 && h > 0 && w < 100000 && h < 100000 {
				return w, h
			}
		}
	}
	return 0, 0
}
