# API

All under `/api/v1`, JSON unless noted. Authenticate with a session cookie, `Authorization: Bearer plab_…` (Settings → API & shortcuts), or a Pocket Core token.

## Pictures

| | |
|---|---|
| `GET /images?q&show&sort&limit&offset` | `{items, total}`; `show` = `edited`, `unedited`, `favorites`, `photos`, `files`, `upload`, `collage`, `copy`; `sort` = `recent`, `added`, `taken`, `title`, `size` |
| `POST /images` | Multipart `file` (one or more), optional `title`, `note`, `thumb` (a data URL, for kinds the server can't read). `{items, already, skipped, id?, url?}`; the same bytes twice are not added again |
| `POST /images/import` | `{"source":"photos","ids":[…]}` (Pocket Photos asset ids) or `{"source":"files","space":"home","paths":[…]}` |
| `GET/PUT/DELETE /images/{id}` | One picture; PUT takes any of `title`, `note`, `favorite`, `recipe` (the edit, see below) |
| `GET /images/{id}/original` | The original, as it came (`?download=1` to save it) |
| `GET /images/{id}/preview` | The current look, JPEG up to 2048 px (the original until edited) |
| `GET /images/{id}/thumb` | 512 px JPEG of the current look |
| `PUT /images/{id}/look` | Body: the rendered look (JPEG/PNG/WebP), as the editor sends it; `?reset=1` goes back to the original |
| `POST /images/{id}/copy` | `{"fresh": true}` starts the copy from the original |
| `GET/POST /images/{id}/versions`, `DELETE /versions/{id}`, `GET /versions/{id}/thumb` | Saved states of an edit |
| `GET/POST /presets`, `PUT/DELETE /presets/{id}`, `GET /presets/{id}/thumb` | Looks of your own (`{name, recipe, thumb?}`) |
| `GET /exports`, `POST /exports` | What left the lab. POST multipart `meta` (`{image_id, destination: download|photos|files|blog|chat|notes|documents, name, format, width, height, folder?, conversation?, title?, text?}`) + `file`; `photos` adds a new photo to Pocket Photos (stacked on its original), `files` saves into Pocket Files, `blog` starts a draft post, `chat` sends a message, `notes` makes a note, `documents` files it |
| `POST /images/apply` | `{ids, look?, strength?, adjust?, aspect?, rotate?, straighten?, black_and_white?, frame?, long_edge?, reset?}` merges a change into each picture's edit (Pocket AI); the look is drawn again the next time a browser has the lab open (`GET /images/stale`) |
| `GET/POST /fonts`, `GET /fonts/{id}/file`, `DELETE /fonts/{id}` | Fonts of your own (TTF, OTF, WOFF, WOFF2) for text |
| `GET /home` | Counts, the latest pictures and exports |
| `GET /sources`, `GET /sources/photos?q&cursor&favorites`, `GET /sources/photos/{asset}/thumb`, `GET /sources/files/spaces`, `GET /sources/files/list?space&path`, `GET /sources/files/thumb?space&path` | Browsing Pocket Photos and Pocket Files through your connection |
| `POST /ai/suggest` `{image, wish}`, `POST /ai/describe` `{image}` | `image` is a small JPEG data URL; answers slider values, a look, a horizon and a crop, or a title, alt text and tags |
| `POST /share` | Web Share Target of the installed app (multipart `file`), redirects to the editor |

## The edit (recipe)

A JSON object the browser applies to the original (`web/src/lib/recipe.ts`); the server stores it as it is. Fractions are of the picture, so an edit gives the same result at any size.

```json
{"v":1, "rotate":90, "flipH":true, "straighten":-1.5, "crop":{"x":0.1,"y":0,"w":0.8,"h":1,"aspect":"4:5"}, "resize":{"w":1080,"h":1350},
 "adjust":{"exposure":12,"contrast":10,"highlights":-20,"shadows":15,"temperature":8,"vibrance":20,"clarity":10,"vignette":15},
 "curves":{"rgb":[[0,0],[64,52],[192,206],[255,255]]}, "hsl":{"blue":{"h":0,"s":-20,"l":0}}, "split":{"sh":210,"ss":20,"hh":40,"hs":15,"balance":0},
 "look":{"name":"film","strength":60}, "effects":{"mono":false,"sepia":0,"tilt":{"y":0.55,"band":0.22,"blur":60}},
 "layers":[{"id":"a","type":"text","x":0.5,"y":0.9,"text":"Lake Bled","font":"serif","size":0.06,"color":"#fff","shadow":true},
           {"id":"b","type":"redact","x":0.6,"y":0.4,"w":0.1,"h":0.06,"mode":"blur","strength":60}],
 "frame":{"width":3,"color":"#ffffff","radius":0,"fit":"none","fill":"color","pad":6}}
```

## Pocket Core links

Offers `photolab:read` (the pictures, their looks and originals, looks, exports) and `photolab:write` (add a picture; change or delete only pictures it added). Uses Pocket Photos (`photos:read`, `photos:write`), Pocket Files (`files:read`, `files:write`), Pocket Blog (`blog:write`), Pocket Chat (`chat:read`, `chat:write`), Pocket Notes (`notes:write`) and Pocket Documents (`documents:write`). Publishes `photolab.image_added`, `photolab.image_edited`, `photolab.image_exported`.
