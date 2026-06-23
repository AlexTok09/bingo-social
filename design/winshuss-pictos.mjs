// Génère un pictogramme style Winshuss par catégorie (FLUX.2 pro + image de référence).
// Usage : node winshuss-pictos.mjs [slug ...]   (sans argument : toutes les catégories)
// Les PNG sont écrits dans design/picto-png/ ; les slugs déjà générés sont sautés.
import Replicate from "replicate";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.REPLICATE_API_TOKEN) {
  process.loadEnvFile(path.join(__dirname, "..", ".env"));
}

const STYLE =
  ", flat cartoon pictogram in the lowbrow pop-surrealist comic style of the reference image: " +
  "bold black outlines, exaggerated goofy features, big expressive eyes, retro halftone shading, " +
  "limited palette of pastel pink, cream, red, sky blue and black, single centered character or object, " +
  "plain white background, sticker style, no text, no letters";

export const CATEGORIES = [
  // ——— Ordinaire ———
  ["papi-et-mami", "an elderly couple walking arm in arm, grandma with handbag, grandpa with flat cap"],
  ["doudoune-sans-manche", "a smug man wearing a sleeveless puffer vest over a shirt"],
  ["vieux-bourgeois", "a posh old wealthy man with a fancy coat, silk scarf and cane, nose in the air"],
  ["femme-et-chien", "a woman walking a tiny fluffy dog on a leash"],
  ["clodo", "a scruffy bearded homeless man sitting on the sidewalk with a paper cup"],
  ["vieille-bourgeoise", "a posh old wealthy lady with pearl necklace, fur coat and tiny sunglasses"],
  ["jean-charles-mariniere", "a smug french man wearing a striped breton shirt and a beret"],
  ["etudiant", "a tired student with a huge backpack, tote bag and headphones"],
  ["hippie", "a happy hippie with long hair, round glasses, flower crown, making a peace sign"],
  ["mr-mme-mechant", "a grumpy mean-looking person scowling with furrowed eyebrows and crossed arms"],
  ["gros-touriste", "a chubby tourist in hawaiian shirt with a camera around the neck and a city map"],
  ["poussette", "a parent pushing a baby stroller with a happy baby inside"],
  ["velo-cargo", "a parent riding a cargo bike with a kid sitting in the front wooden box"],
  ["casquette", "a young person wearing a baseball cap backwards"],
  ["style-de-ouf", "an ultra stylish fashionable person with sunglasses and designer clothes, striking a pose"],
  ["caillra", "a young man in a full tracksuit with a crossbody bag and cap, leaning back"],
  ["fait-la-gueule", "a sulking person pouting hard with arms crossed and a storm cloud above the head"],
  ["heureux-comme-tout", "a person beaming with pure joy, huge smile, sparkles around the head"],
  ["triste-a-souhait", "an extremely sad person with droopy shoulders and a single big tear"],
  ["ultra-frais", "a super fresh confident person strutting with sunglasses and a glowing aura"],
  ["scotche-au-tel", "a person hypnotized by their smartphone, face glued to the screen while walking"],
  ["costard", "a businessman in a sharp suit and tie holding a briefcase"],
  ["shlagos", "a scruffy disheveled slacker guy with messy hair, half-closed eyes and saggy clothes"],
  ["deliveroo", "a food delivery cyclist pedaling fast with a big teal cube backpack"],
  ["taxi", "a classic taxi car with a roof sign"],
  ["deux-amis", "two best friends laughing together with arms over each other's shoulders"],
  ["calvitie", "a man with a shiny bald head, light reflection sparkle on the skull"],
  ["couple-lesbien", "two women in love holding hands with a little heart above them"],
  ["couple-gay", "two men in love holding hands with a little heart above them"],
  ["hipster", "a hipster with a big beard, man bun, tattoos, holding a specialty coffee cup"],
  ["velib", "a city bike-share bicycle with a basket"],
  ["zara-girl", "a trendy girl in fashionable outfit carrying several shopping bags"],
  ["drague-de-rue", "a cheesy man winking and flirting, leaning against a lamppost with a rose"],
  ["creneau", "a car parallel parking into a tight spot between two cars, sweat drops"],
  ["rasta", "a smiling man with long dreadlocks under a big knitted beanie"],
  ["trotinette-electrique", "a person riding an electric kick scooter, scarf flying"],
  ["jogger", "a jogger running in sportswear with a sweatband, sweat drops flying"],
  ["tricot-superbe", "a proud person wearing a gorgeous colorful hand-knitted sweater"],
  ["mange", "a person eating a big sandwich while walking, crumbs flying"],
  ["rire", "a person laughing out loud, head thrown back, tears of joy"],
  ["dock-martins", "a pair of black leather lace-up combat boots with yellow stitching"],
  // ——— Semi-ordinaire ———
  ["pigeon-qui-mange", "a chubby pigeon pecking at a piece of bread on the ground"],
  ["habit-groupe-musique", "a person wearing a black rock band t-shirt with a skull print, doing devil horns"],
  ["baguette", "a person proudly carrying a baguette under the arm"],
  ["maillot-equipe-sport", "a cheerful supporter wearing a football team jersey"],
  ["chariot-de-course", "an old lady pulling a plaid shopping trolley"],
  ["punk-a-chien", "a punk with a mohawk and studded jacket holding a dog on a rope leash"],
  ["panama", "an elegant person wearing a white panama hat"],
  ["bob", "a young person wearing a bucket hat"],
  ["porte-un-instrument", "a musician carrying a big guitar case on the back"],
  ["militaire", "a soldier in camouflage uniform and beret standing straight"],
  ["kit-main-libre", "a person talking loudly with wired earphones, gesturing with both hands"],
  ["son-a-donf", "a person blasting loud music from a portable speaker, music notes everywhere"],
  ["canne", "an elderly person walking slowly with a wooden cane"],
  ["enfant-relou", "a screaming toddler throwing a tantrum on the ground, exhausted parent"],
  ["geek", "a geek with thick glasses and a video game t-shirt, holding a laptop"],
  ["cheveux-jusquau-fesses", "a person with extremely long hair flowing all the way down their back"],
  ["ivre", "a tipsy person wobbling with swirly eyes, bubbles floating around"],
  ["rasta-blanc", "a white guy with blond dreadlocks and baggy clothes, peace sign"],
  ["couple-decathlon", "a couple in matching hiking outfits with zip-off pants and backpacks"],
  ["selfie", "a person taking a selfie with duck face and peace sign"],
  ["danse", "a person dancing joyfully in the street, musical notes around"],
  ["fouille-horodateur", "a person poking fingers into the coin slot of a parking meter"],
  ["lit-un-livre", "a person reading a book while walking, absorbed"],
  ["gens-qui-sembrassent", "a couple kissing with hearts floating above"],
  ["parle-tout-seul", "a person talking to themselves and gesturing wildly, speech bubbles around"],
  ["roule-en-skate", "a skateboarder cruising with knees bent and cap backwards"],
  ["court", "a person in regular clothes sprinting at full speed, late, motion lines"],
  ["trebuche", "a person tripping over their own feet, mid-fall, arms flailing"],
  ["deguise", "a person in a full dinosaur costume waving"],
  ["batons-marche-nordique", "a senior power-walking with two nordic walking poles"],
  ["controle-policier", "two police officers checking ID papers"],
  ["gros-faf", "an angry red-faced man with a crew cut, polo shirt and clenched fists"],
  ["col-roule", "an intellectual person wearing a turtleneck sweater, chin resting on hand"],
  ["embrouille-de-couple", "a couple arguing face to face with angry scribbles between them"],
  ["jette-megot", "a person flicking a cigarette butt on the ground, looking away"],
  ["pull-sur-epaules", "a preppy person with a sweater tied over the shoulders, smug face"],
  // ——— Rare ———
  ["religieux", "a monk in a brown robe with a rope belt, serene smile"],
  ["cheveux-multicolore", "a person with bright rainbow-colored hair"],
  ["pleure", "a person crying loudly with a fountain of tears"],
  ["monocycle", "a person balancing on a unicycle with arms out"],
  ["relation-avec-chat", "a person lovingly hugging and talking to a cat, the cat unimpressed"],
  ["controle-police", "a police officer with a cap writing a ticket"],
  ["bagarre-de-rue", "a cartoon street fight dust cloud with fists and stars poking out"],
  ["pipi-dans-la-rue", "a man seen from behind facing a wall, legs apart, a small puddle at his feet"],
  ["accident-circulation", "two cars in a fender bender, bumpers crumpled, drivers yelling"],
  ["pieds-nus", "a relaxed person walking barefoot, shoes in hand"],
  ["crete-de-punk", "a punk with a tall spiky colorful mohawk and safety pin earrings"],
  ["porte-un-meuble", "two people awkwardly carrying a couch in the street"],
  ["tiktok-danse", "a person filming themselves dancing with a phone on a tripod"],
  ["fou-rire", "a person collapsing in uncontrollable laughter, slapping their knee"],
  ["voiture-mariage", "a wedding car decorated with ribbons, flowers and tin cans trailing behind"],
  ["distribue-flyers", "a person in the street handing out flyers to passersby"],
  ["ballon-de-baudruche", "a shiny party balloon floating on a string"],
  // ——— Légendaire ———
  ["caca-oiseau", "a bird flying over an annoyed person with a white splat landing on their head"],
  ["vol-de-rue", "a sneaky thief running away with a stolen handbag, victim shouting behind"],
  ["nudite", "a naked streaker running, body covered by a black censor bar, comic style"],
  ["mouette-sandwich", "a seagull snatching a sandwich out of a shocked person's hands"],
  ["accouplement", "two dogs cuddling with lots of hearts, a scandalized passerby looking away"],
  ["marche-dans-la-merde", "a shoe stepping into dog poop, stink lines, horrified face above"],
  ["jumeaux", "identical twins dressed exactly the same, standing side by side"],
  ["fume-la-pipe", "a distinguished person smoking a curved wooden pipe, smoke ring"],
  ["cape", "a person walking proudly with a superhero cape fluttering in the wind"],
  ["coupure-electricite", "a dark street with an unlit street lamp and an unplugged power cord, candle glowing"],
  ["enterrement-vie-garcon", "a bachelor party group with sashes, one guy in a silly costume"],
  ["joueur-sociologie-bingo", "an excited person holding a bingo card pointing at another person who also holds a bingo card"],
  ["clown", "a classic clown with a red nose, colorful wig and oversized shoes"],
];

const replicate = new Replicate();
// Data URI : l'upload via l'API files de Replicate est refusé par ce token
const refImage =
  "data:image/jpeg;base64," +
  (await readFile(path.join(__dirname, "Winshuss-ref.jpg"))).toString("base64");
const outDir = path.join(__dirname, "picto-png");
await mkdir(outDir, { recursive: true });

const wanted = process.argv.slice(2);
const todo = CATEGORIES.filter(
  ([slug]) =>
    (wanted.length === 0 || wanted.includes(slug)) &&
    !existsSync(path.join(outDir, `${slug}.png`))
);
console.log(`${todo.length} pictogramme(s) à générer.`);

async function generate([slug, subject]) {
  const output = await replicate.run("black-forest-labs/flux-2-pro", {
    input: {
      prompt: subject + STYLE,
      resolution: "1 MP",
      aspect_ratio: "1:1",
      input_images: [refImage],
      output_format: "png",
      safety_tolerance: 5,
    },
  });
  const data = typeof output === "string"
    ? Buffer.from(await (await fetch(output)).arrayBuffer())
    : Buffer.from(await output.blob().then((b) => b.arrayBuffer()));
  await writeFile(path.join(outDir, `${slug}.png`), data);
}

const failed = [];
let done = 0;
const queue = [...todo];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        await generate(item);
        console.log(`ok    ${item[0]} (${++done}/${todo.length})`);
      } catch (err) {
        failed.push(item[0]);
        console.log(`ÉCHEC ${item[0]} — ${err.message}`);
      }
    }
  })
);

if (failed.length) {
  console.log(`\n${failed.length} échec(s) : ${failed.join(", ")}`);
  console.log("Relance le script pour réessayer uniquement ceux-là.");
} else {
  console.log("\nTout est généré !");
}
