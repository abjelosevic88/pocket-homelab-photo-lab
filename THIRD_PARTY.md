# Third-party parts

Pocket Photo Lab is MIT licensed. It ships these unchanged, each under its own licence:

| What | Used for | Licence |
|---|---|---|
| [U²-Net](https://github.com/xuebinqin/U-2-Net) small model (`u2netp.onnx`, from [rembg](https://github.com/danielgatis/rembg)) | Finding the subject when removing a background | Apache-2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | Running that model in the browser | MIT |
| [libheif](https://github.com/strukturag/libheif) via [libheif-js](https://github.com/catdad-experiments/libheif-js) | Opening HEIC/HEIF pictures in browsers that can't | LGPL-3.0 (with libde265, LGPL-3.0) |

libheif is a separate file the browser loads only when it meets a HEIC picture (`assets/libheif-bundle-*.js`); it can be replaced with another build of the same version. Its source is at the links above.
