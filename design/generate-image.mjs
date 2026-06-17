// Génère une image avec FLUX.2 [pro] via Replicate.
// Usage : node generate-image.mjs "ton prompt ici" [nom-fichier]
import Replicate from "replicate";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Charge la clé depuis Bingo/.env si elle n'est pas déjà dans l'environnement
if (!process.env.REPLICATE_API_TOKEN) {
  try {
    process.loadEnvFile(path.join(__dirname, "..", ".env"));
  } catch {
    console.error("Clé manquante : définis REPLICATE_API_TOKEN ou crée Bingo/.env");
    process.exit(1);
  }
}

const prompt = process.argv[2];
if (!prompt) {
  console.error('Usage : node generate-image.mjs "ton prompt" [nom-fichier]');
  process.exit(1);
}
const name = process.argv[3] ?? `image-${Date.now()}`;

const replicate = new Replicate();

console.log("Génération en cours…");
const output = await replicate.run("black-forest-labs/flux-2-pro", {
  input: {
    prompt,
    resolution: "1 MP",
    aspect_ratio: "1:1",
    output_format: "webp",
    output_quality: 80,
    safety_tolerance: 2,
  },
});

const outDir = path.join(__dirname, "generated");
await mkdir(outDir, { recursive: true });
const file = path.join(outDir, `${name}.webp`);

// replicate.run renvoie un FileOutput (ou une URL selon la version)
const data = typeof output === "string"
  ? Buffer.from(await (await fetch(output)).arrayBuffer())
  : Buffer.from(await output.blob().then((b) => b.arrayBuffer()));

await writeFile(file, data);
console.log(`Image enregistrée : ${file}`);
