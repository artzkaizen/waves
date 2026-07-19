// Spike: run @vladmandic/human under Bun with no native TFJS binary and no DOM.
// Feed it raw decoded JPEG pixels as a tensor; confirm we get a 468-point face mesh.
import { Human } from "./node_modules/@vladmandic/human/dist/human.node-wasm.js";
import jpeg from "jpeg-js";

const human = new Human({
  backend: "wasm", wasmPath: "./node_modules/@tensorflow/tfjs-backend-wasm/dist/",
  modelBasePath: "https://vladmandic.github.io/human-models/models/",
  face: {
    enabled: true,
    detector: { rotation: false },
    mesh: { enabled: true },
    iris: { enabled: false },
    description: { enabled: false },
    emotion: { enabled: false },
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
});

console.log("tf backend:", human.tf.getBackend());
await human.load();
console.log("models loaded");

const bytes = await Bun.file(process.argv[2]).arrayBuffer();
const raw = jpeg.decode(new Uint8Array(bytes), { useTArray: true, formatAsRGBA: true });
console.log("frame", raw.width, "x", raw.height);

// RGBA → RGB tensor [1, h, w, 3]
const rgb = new Uint8Array(raw.width * raw.height * 3);
for (let i = 0, j = 0; i < raw.data.length; i += 4, j += 3) {
  rgb[j] = raw.data[i];
  rgb[j + 1] = raw.data[i + 1];
  rgb[j + 2] = raw.data[i + 2];
}
const tensor = human.tf.tensor(rgb, [1, raw.height, raw.width, 3], "float32");

const result = await human.detect(tensor);
tensor.dispose();

console.log("faces:", result.face.length);
if (result.face.length) {
  const mesh = result.face[0].mesh;
  console.log("mesh points:", mesh.length);
  const v = Math.abs(mesh[14][1] - mesh[13][1]) / raw.height;
  const h = Math.abs(mesh[291][0] - mesh[61][0]) / raw.width;
  console.log("mouth vertical:", v.toFixed(5), "horizontal:", h.toFixed(5));
}
