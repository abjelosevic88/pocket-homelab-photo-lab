package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"math"
	"math/rand"
	"time"

	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/imaging"
	"github.com/abjelosevic88/pocket-homelab-photo-lab/internal/store"
)

// seedDemo fills the owner's lab with painted landscapes, some of them
// edited, a few looks of their own and an export log (DEMO_DATA=true, for
// screenshots and trying the app). Runs once.
func (s *Server) seedDemo(ctx context.Context, owner int64) error {
	ctx = context.WithoutCancel(ctx)
	key := fmt.Sprintf("seeded:%d:demo", owner)
	if _, _, done := s.store.CacheGet(ctx, key); done {
		return nil
	}
	rng := rand.New(rand.NewSource(42))
	type demo struct {
		title, name, scene string
		w, h               int
		daysAgo            int
		favorite           bool
		recipe             string
		look               func(color.RGBA) color.RGBA
		note               string
	}
	warm := func(c color.RGBA) color.RGBA { return tone(c, 1.08, 1.1, 1.15, 14) }
	crisp := func(c color.RGBA) color.RGBA { return tone(c, 1.12, 1.18, 1.2, 0) }
	brighten := func(c color.RGBA) color.RGBA { return tone(c, 1.55, 1.12, 1.25, 10) }
	mono := func(c color.RGBA) color.RGBA {
		l := uint8(math.Min(255, 0.2126*float64(c.R)+0.7152*float64(c.G)+0.0722*float64(c.B)))
		return tone(color.RGBA{l, l, l, 255}, 1.05, 1.25, 1, 0)
	}
	demos := []demo{
		{"Sunset over the lake", "IMG_4821.jpg", "sunset", 1500, 1000, 2, true,
			`{"v":1,"adjust":{"exposure":8,"contrast":12,"highlights":-25,"shadows":18,"temperature":14,"vibrance":20},"look":{"name":"golden","strength":45},"crop":{"x":0.04,"y":0.06,"w":0.92,"h":0.88,"aspect":"3:2"},"layers":[{"id":"t1","type":"text","x":0.5,"y":0.9,"text":"Lake Bled, June","font":"serif","size":0.06,"color":"#ffffff","bold":false,"italic":true,"align":"center","rotate":0,"shadow":true,"opacity":0.95}]}`, warm, "For the calendar on the fridge."},
		{"Morning in the hills", "DSC01933.jpg", "hills", 1500, 1000, 5, false,
			`{"v":1,"adjust":{"contrast":15,"clarity":20,"vibrance":25,"dehaze":12},"look":{"name":"vivid","strength":40}}`, crisp, ""},
		{"Dunes at noon", "IMG_5102.jpg", "dunes", 1500, 1000, 9, false, "", nil, ""},
		{"The city at night", "night-city.jpg", "city", 1500, 1000, 12, true,
			`{"v":1,"adjust":{"exposure":-6,"contrast":20,"blacks":-15,"temperature":-12},"look":{"name":"teal-orange","strength":55},"frame":{"width":3,"color":"#ffffff","radius":0}}`, func(c color.RGBA) color.RGBA { return tone(c, 0.95, 1.2, 1.1, -10) }, ""},
		{"Northern lights", "aurora_tromso.jpg", "aurora", 1500, 1000, 20, true, "", nil, "Tromsø, 2 am, minus 18."},
		{"Fog in the pines", "IMG_3310.jpg", "forest", 1000, 1500, 27, false,
			`{"v":1,"adjust":{"contrast":10,"fade":18},"look":{"name":"mono","strength":100},"effects":{"mono":true}}`, mono, ""},
		{"Lavender rows", "lavender.jpg", "lavender", 1000, 1500, 33, false, "", nil, ""},
		{"Beach, too dark", "IMG_6650.jpg", "beach-dark", 1500, 1000, 40, false,
			`{"v":1,"adjust":{"exposure":42,"shadows":35,"highlights":-10,"temperature":10,"vibrance":18}}`, brighten, "Shot against the light; lifted the shadows."},
		{"Harbour", "harbour.jpg", "coast", 1500, 1000, 55, false, "", nil, ""},
	}
	var first *store.Image
	for i, d := range demos {
		img := paint(d.scene, d.w, d.h, rng)
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 88}); err != nil {
			return err
		}
		data := buf.Bytes()
		rel, err := s.writeFile(owner, "demo", ".jpg", data)
		if err != nil {
			return err
		}
		at := time.Now().AddDate(0, 0, -d.daysAgo).Add(-time.Duration(rng.Intn(600)) * time.Minute)
		im := &store.Image{Title: d.title, File: rel, Mime: "image/jpeg", Width: d.w, Height: d.h, Bytes: int64(len(data)),
			SHA256: fmt.Sprintf("demo-%d", i), Source: []string{"photos", "upload", "files"}[i%3], SourceName: d.name, Favorite: d.favorite, Note: d.note,
			TakenAt: at.Add(-72 * time.Hour).Format("2006-01-02T15:04:05")}
		if im.Source == "photos" {
			im.SourceRef = fmt.Sprintf("00000000-0000-4000-8000-%012d", i+1)
		}
		look := image.Image(img)
		if d.recipe != "" {
			im.Recipe, im.Edited, im.EditedAt = json.RawMessage(d.recipe), true, at.Add(30*time.Minute).UTC().Format(time.RFC3339Nano)
			look = bake(img, d.look)
			var pb bytes.Buffer
			_ = jpeg.Encode(&pb, imaging.Fit(look, previewEdge), &jpeg.Options{Quality: 88})
			if im.Preview, err = s.writeFile(owner, "looks", ".jpg", pb.Bytes()); err != nil {
				return err
			}
		}
		thumb, _ := imaging.Thumb(look, thumbEdge, 82)
		if err := s.store.CreateImage(ctx, owner, im, thumb); err != nil {
			return err
		}
		stamp := at.UTC().Format(time.RFC3339Nano)
		_, _ = s.store.DB.ExecContext(ctx, `UPDATE images SET created_at = ?, updated_at = ? WHERE id = ?`, stamp, firstNonEmpty(im.EditedAt, stamp), im.ID)
		if i == 0 {
			first = im
		}
	}
	if first != nil {
		for _, v := range []struct{ name, recipe string }{
			{"Straight from the camera", `{}`},
			{"Before the text", `{"v":1,"adjust":{"exposure":8,"contrast":12,"highlights":-25,"shadows":18,"temperature":14,"vibrance":20},"look":{"name":"golden","strength":45}}`},
		} {
			_ = s.store.CreateVersion(ctx, owner, &store.Version{ImageID: first.ID, Name: v.name, Recipe: json.RawMessage(v.recipe)}, nil)
		}
	}
	for i, p := range []struct{ name, recipe string }{
		{"Warm evening", `{"v":1,"adjust":{"temperature":22,"tint":4,"contrast":8,"vibrance":15,"vignette":20},"look":{"name":"golden","strength":35}}`},
		{"Crisp and clear", `{"v":1,"adjust":{"contrast":18,"clarity":25,"dehaze":15,"vibrance":20,"sharpen":30}}`},
		{"Quiet film", `{"v":1,"adjust":{"fade":22,"grain":25,"contrast":-8,"saturation":-15},"look":{"name":"film","strength":60}}`},
	} {
		_ = s.store.CreatePreset(ctx, owner, &store.Preset{Name: p.name, Recipe: json.RawMessage(p.recipe), Sort: i}, nil)
	}
	ims, _, _ := s.store.ListImages(ctx, owner, store.ImageFilter{Sort: "added", Limit: 20})
	for i, im := range ims {
		if !im.Edited {
			continue
		}
		id := im.ID
		dest := []string{"photos", "download", "files"}[i%3]
		e := &store.Export{ImageID: &id, Title: im.Title, Format: "jpeg", Width: im.Width, Height: im.Height, Bytes: 600_000 + int64(rng.Intn(900_000)), Destination: dest}
		if dest == "files" {
			e.Target = "/Photo Lab/" + im.Title + "-edited.jpg"
		}
		_ = s.store.CreateExport(ctx, owner, e)
	}
	s.log.Info("demo data seeded", "owner", owner)
	return s.store.CachePut(ctx, key, "1")
}

// ---- a small landscape painter (demo pictures only) ----

func clamp8(v float64) uint8 {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v + 0.5)
}

type rgb struct{ r, g, b float64 }

func mix(a, b rgb, t float64) rgb {
	t = math.Max(0, math.Min(1, t))
	return rgb{a.r + (b.r-a.r)*t, a.g + (b.g-a.g)*t, a.b + (b.b-a.b)*t}
}

func hx(v uint32) rgb { return rgb{float64(v >> 16 & 255), float64(v >> 8 & 255), float64(v & 255)} }

// noise is smooth value noise with a fixed lattice per picture.
type noise struct{ p [512]float64 }

func newNoise(rng *rand.Rand) *noise {
	n := &noise{}
	for i := range n.p {
		n.p[i] = rng.Float64()
	}
	return n
}

func (n *noise) at(x, y float64) float64 {
	xi, yi := int(math.Floor(x)), int(math.Floor(y))
	fx, fy := x-math.Floor(x), y-math.Floor(y)
	h := func(i, j int) float64 { return n.p[((i*73856093)^(j*19349663))&511] }
	sx, sy := fx*fx*(3-2*fx), fy*fy*(3-2*fy)
	a := h(xi, yi) + (h(xi+1, yi)-h(xi, yi))*sx
	b := h(xi, yi+1) + (h(xi+1, yi+1)-h(xi, yi+1))*sx
	return a + (b-a)*sy
}

func (n *noise) fbm(x, y float64, oct int) float64 {
	v, amp, sum := 0.0, 0.5, 0.0
	for i := 0; i < oct; i++ {
		v += amp * n.at(x, y)
		sum += amp
		x, y, amp = x*2.03, y*2.03, amp*0.5
	}
	return v / sum
}

// ridge is a skyline: the height (0 top … 1 bottom) of a mountain or hill line at x.
func ridge(n *noise, x, base, amp, scale float64, oct int) float64 {
	return base - amp*(n.fbm(x*scale, 3.7, oct)-0.5)*2
}

func paint(scene string, w, h int, rng *rand.Rand) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	n := newNoise(rng)
	n2 := newNoise(rng)
	fw, fh := float64(w), float64(h)
	set := func(x, y int, c rgb) {
		i := img.PixOffset(x, y)
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = clamp8(c.r), clamp8(c.g), clamp8(c.b), 255
	}
	for y := 0; y < h; y++ {
		v := float64(y) / fh
		for x := 0; x < w; x++ {
			u := float64(x) / fw
			ar := fw / fh
			var c rgb
			switch scene {
			case "sunset", "beach-dark", "coast":
				horizon := 0.62
				if scene != "sunset" {
					horizon = 0.55
				}
				sunX, sunY := 0.62, horizon-0.07
				top, mid, low := hx(0x2b2d6e), hx(0xe0655a), hx(0xffc46b)
				if scene == "coast" {
					top, mid, low = hx(0x3b78c4), hx(0x8ec1e8), hx(0xdcecf5)
					sunX, sunY = 0.25, 0.18
				}
				sky := mix(top, mid, v/horizon*1.15)
				sky = mix(sky, low, math.Pow(math.Max(0, v/horizon-0.55)/0.45, 1.5))
				d := math.Hypot((u-sunX)*ar, v-sunY)
				glow := math.Exp(-d * 9)
				sun := hx(0xfff2c8)
				if scene == "coast" {
					sun = hx(0xffffff)
					glow *= 0.5
				}
				sky = mix(sky, sun, glow*0.9)
				if d < 0.045 {
					sky = sun
				}
				cl := n2.fbm(u*4*ar, v*9, 5)
				if scene == "coast" {
					sky = mix(sky, hx(0xffffff), math.Max(0, cl-0.55)*2.2*(1-v/horizon))
				} else {
					sky = mix(sky, hx(0xff8f7a), math.Max(0, cl-0.58)*1.6*(1-v/horizon))
				}
				m1 := ridge(n, u*ar, horizon-0.02, 0.16, 1.4, 5)
				m2 := ridge(n2, u*ar+5, horizon-0.005, 0.08, 2.5, 5)
				c = sky
				if scene == "sunset" {
					if v > m1 {
						c = mix(hx(0x3d2c5c), hx(0x5a3a5e), (v-m1)*3)
					}
					if v > m2 {
						c = mix(hx(0x241a3a), hx(0x2e2140), (v-m2)*4)
					}
				}
				if v > horizon {
					// water: the sky mirrored, darker, with ripples
					ry := horizon - (v-horizon)*0.9 + 0.006*math.Sin(v*420+n.at(u*30, v*60)*6)
					rc := mix(top, mid, ry/horizon*1.15)
					rc = mix(rc, low, math.Pow(math.Max(0, ry/horizon-0.55)/0.45, 1.5))
					rd := math.Abs(u-sunX) * ar
					rc = mix(rc, sun, math.Exp(-rd*14)*0.75*(1-(v-horizon)*1.6))
					c = mix(rc, hx(0x1d2340), 0.25+(v-horizon)*0.9)
					if scene == "coast" {
						c = mix(hx(0x2a6fa8), hx(0x16476e), (v-horizon)*2.2)
						c = mix(c, hx(0xffffff), math.Max(0, n.at(u*80, v*400)-0.82)*3)
						sand := 0.8 + 0.03*math.Sin(u*9)
						if v > sand {
							c = mix(hx(0xe8d2a8), hx(0xcfb184), (v-sand)*4+n.at(u*200, v*200)*0.2)
						} else if v > sand-0.012 {
							c = mix(c, hx(0xffffff), 0.7)
						}
					}
				}
				if scene == "beach-dark" {
					c = rgb{c.r*0.45 - 4, c.g*0.48 - 2, c.b*0.58 + 6}
				}
			case "hills":
				sky := mix(hx(0x6fa8dc), hx(0xd7e9f5), v/0.5)
				cl := n2.fbm(u*3*ar, v*7, 6)
				sky = mix(sky, hx(0xffffff), math.Max(0, cl-0.5)*2.4*(1-v/0.5))
				c = sky
				layers := []struct {
					base, amp, sc float64
					col           rgb
				}{{0.48, 0.1, 1.2, hx(0x8fb3a3)}, {0.56, 0.1, 1.6, hx(0x6f9a5b)}, {0.66, 0.11, 2.0, hx(0x4f8a3c)}, {0.8, 0.1, 2.6, hx(0x3c6e2b)}}
				for k, l := range layers {
					rr := ridge(n, u*ar+float64(k)*7, l.base, l.amp, l.sc, 5)
					if v > rr {
						shade := n2.fbm(u*12, v*12, 4)
						c = mix(l.col, hx(0xe8f0c8), math.Max(0, 0.18-(v-rr))*1.2)
						c = mix(c, rgb{c.r * 0.8, c.g * 0.85, c.b * 0.8}, shade*0.6)
						if k == 3 && n.at(u*90, v*30) > 0.8 {
							c = hx(0x24451a)
						}
					}
				}
				c = mix(c, hx(0xf2f6ff), math.Max(0, 0.55-v)*0.25)
			case "dunes":
				c = mix(hx(0x5b9bd5), hx(0xf3dcc0), math.Pow(v/0.45, 1.3))
				for k := 0; k < 4; k++ {
					base := 0.42 + float64(k)*0.13
					rr := base - 0.07*math.Sin(u*ar*(2.2+float64(k))+float64(k)*1.7) - 0.03*n.fbm(u*3, float64(k), 3)
					if v > rr {
						slope := math.Cos(u*ar*(2.2+float64(k)) + float64(k)*1.7)
						lit := mix(hx(0xd98a4e), hx(0xf6c28b), 0.5+0.5*slope)
						c = mix(lit, hx(0x9c5a33), math.Min(1, (v-rr)*1.8)*0.5)
						c = mix(c, hx(0xffffff), math.Max(0, n.at(u*400, v*90)-0.85)*0.8)
					}
				}
			case "city":
				c = mix(hx(0x0b1030), hx(0x2a2d5c), v/0.7)
				if n.at(u*700, v*700) > 0.985 && v < 0.5 {
					c = hx(0xf0f0ff)
				}
				md := math.Hypot((u-0.78)*ar, v-0.18)
				c = mix(c, hx(0xfdf6e3), math.Exp(-md*22)*0.6)
				if md < 0.04 {
					c = hx(0xfdf6e3)
				}
				col := int(u * 46)
				bh := 0.35 + 0.35*n.at(float64(col)*1.7, 2.2)
				if col%7 == 3 {
					bh -= 0.12
				}
				if v > bh && v < 0.86 {
					c = hx(0x10132a)
					wx, wy := math.Mod(u*46*6, 1), math.Mod(v*90, 1)
					if wx > 0.3 && wx < 0.7 && wy > 0.3 && wy < 0.75 && n2.at(u*276, v*90) > 0.52 {
						c = mix(hx(0xffd27a), hx(0xff9b4a), n.at(u*300, v*80))
					}
				}
				if v >= 0.86 {
					ry := 0.86 - (v - 0.86)
					c = mix(hx(0x10132a), hx(0x1b1f45), (v-0.86)*4)
					wx := math.Mod(u*46*6, 1)
					if wx > 0.35 && wx < 0.65 && n2.at(u*276, ry*90) > 0.55 && n.at(u*20, v*300) > 0.4 {
						c = mix(c, hx(0xffb35a), 0.55)
					}
				}
			case "aurora":
				c = mix(hx(0x050a1f), hx(0x0f2140), v/0.7)
				if n.at(u*800, v*800) > 0.988 {
					c = hx(0xe8f0ff)
				}
				band := 0.25 + 0.12*math.Sin(u*ar*2.4+1) + 0.08*(n.fbm(u*2*ar, 1.3, 4)-0.5)
				dist := v - band
				if dist > -0.25 && dist < 0.12 {
					curtain := n2.fbm(u*40*ar, 0.5, 3)
					inten := math.Exp(-math.Pow(dist/0.06, 2)) * (0.4 + curtain)
					up := math.Max(0, -dist) / 0.25
					c = mix(c, hx(0x3dffb0), inten*0.9*(1-up*0.6))
					c = mix(c, hx(0xa45cff), math.Max(0, -dist-0.05)*2.5*curtain*0.7)
				}
				rr := ridge(n, u*ar, 0.7, 0.14, 1.8, 6)
				if v > rr {
					snow := n2.fbm(u*20, v*20, 4)
					c = mix(hx(0x1c2b45), hx(0xbcd3f0), math.Max(0, 0.06-(v-rr))*10+snow*0.25)
				}
				if v > 0.86 {
					c = mix(hx(0x0c1424), hx(0x1d2d48), n.at(u*30, v*30))
				}
			case "forest":
				c = mix(hx(0xc9d3d6), hx(0xe9eeee), v)
				for k := 0; k < 5; k++ {
					fog := float64(k) / 4
					base := 0.45 + float64(k)*0.12
					tx := u*ar*(8+float64(k)*3) + float64(k)*13
					cell := tx - math.Floor(tx)
					tall := 0.25 + 0.2*n.at(math.Floor(tx), float64(k)*5)
					top := base - tall*(1-math.Abs(cell-0.5)*2)
					if v > top {
						dark := mix(hx(0x9fb0b2), hx(0x1f2e2a), fog)
						c = mix(dark, hx(0xdfe6e6), math.Max(0, 0.08-(v-top))*3*(1-fog))
					}
				}
				c = mix(c, hx(0xeef2f2), math.Max(0, n2.fbm(u*3, v*6, 4)-0.45)*0.9)
			case "lavender":
				c = mix(hx(0x7aa6d8), hx(0xf7d9c4), v/0.38)
				if v > 0.36 {
					c = mix(hx(0x8aa0c0), hx(0x6d7f9e), (v-0.36)*10)
				}
				if v > 0.4 {
					p := (v - 0.4) / 0.6
					xx := (u - 0.5) / (0.05 + p)
					row := math.Mod(xx*6+100, 1)
					purple := mix(hx(0x6a4c9c), hx(0x9a7bd0), n.at(u*300, v*300))
					green := mix(hx(0x3d5a2c), hx(0x5c7a3a), n.at(u*80, v*80))
					c = mix(purple, green, math.Pow(math.Abs(row-0.5)*2, 3))
					c = mix(c, hx(0xc9b8e8), math.Max(0, 0.06-(v-0.4))*8)
				}
			}
			// a little grain, like a real photo
			gr := (n.at(float64(x)*0.9, float64(y)*0.9) - 0.5) * 6
			set(x, y, rgb{c.r + gr, c.g + gr, c.b + gr})
		}
	}
	return img
}

// tone is a rough stand-in for the editor's look, used only to paint the
// demo pictures' previews: exposure, contrast, saturation and warmth.
func tone(c color.RGBA, exp, con, sat, warm float64) color.RGBA {
	r, g, b := float64(c.R)*exp, float64(c.G)*exp, float64(c.B)*exp
	r, g, b = (r-128)*con+128, (g-128)*con+128, (b-128)*con+128
	l := 0.2126*r + 0.7152*g + 0.0722*b
	r, g, b = l+(r-l)*sat, l+(g-l)*sat, l+(b-l)*sat
	return color.RGBA{clamp8(r + warm), clamp8(g + warm*0.3), clamp8(b - warm), 255}
}

func bake(src *image.RGBA, f func(color.RGBA) color.RGBA) *image.RGBA {
	if f == nil {
		return src
	}
	out := image.NewRGBA(src.Bounds())
	for i := 0; i < len(src.Pix); i += 4 {
		c := f(color.RGBA{src.Pix[i], src.Pix[i+1], src.Pix[i+2], 255})
		out.Pix[i], out.Pix[i+1], out.Pix[i+2], out.Pix[i+3] = c.R, c.G, c.B, 255
	}
	return out
}
