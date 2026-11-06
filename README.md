# Sloply (Chrome extension)

**All rights reserved.** This source is public to read, not to reuse. See [LICENSE](LICENSE). The third-party libraries in `lib/` are left out; [lib/README.md](lib/README.md) says where to get them. Get Sloply from the [Chrome Web Store](https://chromewebstore.google.com/detail/slopless/imemjjpgjcmkbcpoglmpieekihphjidk).

*More interest, less slop.*

Blurs images and videos that are most likely AI-generated, and points out AI-written text. Each
blurred image or video shows a warning ("This video is most likely AI-generated") and a **View
anyway** button; after you reveal something, a small **Likely AI · Hide** tag stays on it so you
can blur it again. AI-written text isn't blurred: a small badge in the corner of the page says how
likely it is AI-written and, when opened, lists the passages.

Everything runs on your computer. No paid services, and nothing you browse is sent anywhere.

## Install (developer mode)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this `ai-blocker` folder
4. Reload any open tabs

The project is in git, but the two model files (`models/**/*.onnx`, 120 MB and 255 MB) are not:
they're over GitHub's 100 MB limit. In a fresh copy, rebuild them with the steps under "Text model"
and "Image model" below before loading the extension.

A developer install reads the models from `models/` (image model about 120 MB, text model about
270 MB), so nothing is downloaded at run time. The Chrome Web Store build leaves them out and
downloads them the first time they're needed; see "Model files: bundled or downloaded" below.

A copy loaded this way works with no plan, and the popup says "Developer copy". Store installs get the
7-day trial, then need one: the store adds `update_url` to their manifest, and `license.js` checks
for it, and `store/build-store-zip.sh` removes this unlock from what the store gets. To test the trial and paywall on an unpacked copy, run `chrome.storage.local.set({ devPaywall: true })` in the service
worker's console, then set it to `false` to go back.

## Model files: bundled or downloaded

`MODELS_URL` at the top of `models.js` picks where the model files come from:

- **Empty (this folder):** read from `models/` inside the extension. Nothing is downloaded.
- **A URL (Chrome Web Store build):** a copy of `models/`, same layout, hosted on Hugging Face.
  Each file is downloaded the first time a model is needed (about 390 MB in all, once) and kept in
  the browser's Cache Storage. The cache belongs to the extension, so it survives extension
  updates and is removed when the extension is uninstalled. Until the download finishes, the
  popup's model line shows "loading N%", and checks that need a model wait for it.

The store build downloads because bundling would make the install about 405 MB instead of
about 7 MB, and every version would upload and review the same 390 MB again. The store accepts
packages up to 2 GB, so bundling would also have worked. The costs are a one-time download on first
use, a dependency on Hugging Face being reachable for that first download, and one request to
Hugging Face that the privacy policy has to mention. The models are data run by the bundled ONNX
Runtime, not code, so this is allowed under Manifest V3's ban on remotely hosted code.

Tested with `test/models-test.html?remote&auto`, which loads the models from the local server's
`models/` folder over HTTP: all checks pass, all 7 files land in the cache, each file's data is
downloaded once, and a reload reads everything from the cache (one small 404 remains, where the
image pipeline looks for a `tokenizer_config.json` it doesn't have).

To publish:

1. Create a Hugging Face model repo (for example `USER/slopless-models`), upload this
   `models/` folder to its root, and use `../store/hf-models-README.md` as its README:
   ```bash
   huggingface-cli upload USER/slopless-models models .
   ```
2. Copy the commit hash of that upload from the repo's history page.
3. Build the store zip, pinned to that commit so the files can't change after review:
   ```bash
   ../store/build-store-zip.sh https://huggingface.co/USER/slopless-models/resolve/COMMIT_HASH/
   ```
   It copies the extension to `../store/dist/` without `models/`, `test/` or this README, sets
   `MODELS_URL`, and zips it.

## How it decides

The approach follows how commercial detectors work: trained classifiers for images, video
and text, plus explainable writing-pattern rules. It uses free open-source models in place of
their private ones.

**Platform AI labels** (checked first on YouTube, Instagram, Facebook, TikTok and Pinterest):
these sites label some posts as AI-made themselves, from the uploader's disclosure or the file's
Content Credentials. When a post carries one, its picture or video is blurred and the warning
names the platform and the label.
- Labels matched: YouTube "Altered or synthetic content"; Instagram and Facebook "AI info" /
  "Made with AI"; TikTok "Creator labeled as AI-generated" / "AI-generated"; Pinterest
  "AI modified" / "May be modified with AI".
- The label must be the whole text (or accessibility name) of a short element, so a comment that
  mentions "AI info" doesn't count. From the label it looks up to the post's own media (at least
  150 px, so avatars are skipped) and stops at the post's edge, so a labeled text post can't blur
  the next post's photo.
- On YouTube watch and Shorts pages it also reads the video's page data
  (`containsSyntheticMedia`), because the label sits in the description, which is often collapsed.
- Can be turned off in the popup ("Platform AI labels").

**Images** (first strong signal wins):
- Hosted on an AI generator's servers, or the alt text / caption says it's AI
- File metadata: IPTC `trainedAlgorithmicMedia` tag (OpenAI, Google, Adobe and Meta add this),
  Content Credentials (C2PA) naming a generator, Stable Diffusion / ComfyUI settings in PNGs
- The **haywoodsloan AI-image detector** (SwinV2 vision model, Apache 2.0) looks at the pixels.
  It's converted to 4-bit ONNX and runs on the graphics card (WebGPU) when available; see "Image model" below.

**Videos**:
- Labels and captions (e.g. "made with Sora"), and the thumbnail if it scores 90%+
- While the video plays on screen, frames are captured and scored by the same image model: every
  2.5 seconds for the first 6 frames, then every 10 seconds, for up to about 5 minutes of playback.
  The video is blurred and paused as soon as two frames in a row both score over the threshold.
  This is how Hive's extension combines frame scores; an average would hide an AI clip inside a
  mostly real video, and a single odd frame can't trigger it.
  Frames come from a screenshot of the tab, because sites don't let extensions read video pixels directly.

**Text** (paragraphs of 280+ characters). It's flagged if either check is confident:
- **Writing-pattern check** (`text-detector.js`), based on Wikipedia's field guide
  [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing):
  - overused "AI vocabulary" by chatbot era (from *delve* and *tapestry* to 2026's *leverage* and *multifaceted*), weighted by how many different ones appear together
  - puffed-up significance ("marking a pivotal moment"), tacked-on "-ing" commentary (", highlighting its importance"),
    ad-like language ("nestled in the heart of"), vague sourcing ("experts argue"), name-dropped media coverage
  - "not X, but Y" contrasts, avoiding plain "is" ("serves as a"), formulaic "despite these challenges" endings
  - mid-2026 hedging ("based on available information"), leftover chatbot talk ("I hope this helps"), pasted Markdown
  - weaker signs: em dashes (now fading, since newer chatbots avoid them), mixed curly and straight quotes, even sentence lengths
  - the guide's signs of human writing (plain "is/has", simple verbs, qualifiers like "very") lower the score slightly
- **Vanguard AI-text detector** (ModernBERT-large, MIT license), trained on about 1.1 million human
  and AI texts. It reads up to 512 tokens and outputs the probability the text is AI. It runs on the
  graphics card when available (~0.15 s per paragraph on an M3) and the CPU otherwise (~2 s). It
  replaced an earlier "how predictable is this text" check (SmolLM2 perplexity), which missed
  casual writing from current models; see "Text model" below.

**Articles and blog posts.** Blog posts are usually split into short paragraphs, each too short
to judge alone. So the page's main text is also scored as a whole: it finds the article body the
way reader modes do (the element holding the most paragraph text, or its enclosing `<article>`),
and only when it's marked up as an article or post (`<article>`, `<main>`, or a post/entry/content
container, as blog software uses), so unrelated paragraphs that share a parent aren't judged as one text. It
runs the writing-pattern check on all of it, and averages the text model over 350-word sections
(up to 4). If the article as a whole is likely AI, it's listed once in the badge instead of
paragraph by paragraph. Up to 3 articles per page; articles need at least 150 words.

**The AI-text badge** (`badge.js`): a small pill in the bottom-right corner, "Likely AI-written ·
91%", shown only when a page has AI-written text. Clicking it opens a card with the reasons and
the flagged passages (or the article); clicking a passage scrolls to it and outlines it for two
seconds, and **Not AI** reports a mistake and drops it. Closing the badge (×) keeps it closed on
that page. Nothing on the page is blurred, highlighted or moved.

**Hiding (optional, in the popup's "Hide" group).**
- **AI answers in search** (on by default): removes Google's and Bing's "AI Overview", DuckDuckGo's
  "Search Assist", and the AI answers Google puts inside opened "People also ask" questions, plus the
  tabs and buttons that open AI chat (Google and Bing "AI Mode", DuckDuckGo "Search Assist" and
  "Duck.ai"). It starts from the answer's heading (Bing draws its title without text, so there it
  starts from the answer's container) and hides the block around it, stopping before any normal
  result, before "People also ask" itself, and before Bing's other top answers. Checked on the live
  sites (Oct 2026); `test/ai-features-test.html` has the layouts. Not covered: Reddit Answers and
  Gmail's "Help me write" (their pages couldn't be inspected for this).
- **YouTube videos about AI** (off by default): hides videos whose title or description is about AI
  from the home page, search, the sidebar, Shorts shelves and playlists, and covers the player (with
  "View anyway") when one is opened directly. Titles and descriptions are matched against AI terms
  (*AI*, *ChatGPT*, *machine learning*, *Claude Code*, *Sora 2*, …). Ambiguous words only count with
  context, so "Sora" from Kingdom Hearts, Gemini the zodiac sign, Claude Monet and llamas aren't hidden.
  - Lists don't show descriptions (search shows only an excerpt), so each video's description is
    fetched once from YouTube's own player endpoint (about 15 KB, 4 at a time, no cookies, so it isn't
    tied to your account or watch history). Videos may show for a moment before they're hidden.
  - Lines with links are ignored (sponsor lists, gear links), as is AMD's "Ryzen AI" chip name. On
    five live searches that weren't about AI (75 videos), that cut description-only hides from 13 to
    5; most of the 5 do mention AI in the text ("Will AI take over [your job]…"), but a laptop
    named "Swift Go AI" and a "Neural Network Newsletter" footer still count.
  - **Your own words and channels** (the popup's "Edit" link opens the settings page): extra words
    or phrases that count as AI, words that never count (like "Swift Go AI"), and channels that are
    never hidden (by name or @handle). Words match whole words, any capitalization. The page has a
    box to try a title against your lists.

Items are flagged when the score is at or above the popup's threshold (default 70%). Flagged images
and videos are blurred behind a warning with "View anyway", and flagged text goes in the badge; or,
with **Remove** picked in the popup ("When flagged: Blur / Remove"), flagged images, videos and text
are taken off the page with no warning. Switching back to Blur brings removed items back. The cover
over a YouTube video about AI you opened yourself stays a cover in either mode.

A removed picture or video takes the item it belongs to with it (its link, figure and caption,
search-result tile or pin card), so no empty frame or caption is left behind. It climbs from the
picture while the surrounding element adds nothing else: no other picture or video of 40 px or more,
at most a caption's worth of text (300 characters under the picture, 160 beside it), and not much
more height. It stops before the page's main areas (articles, lists, sections), so an image in an
article removes just the image. On grid layouts that flow (Google Images), the grid closes up; on
sites that place every tile with their own script (Pinterest-style masonry), a gap can remain until
the site lays the page out again. `test/remove-test.html` covers the layouts.

On YouTube, hovering a thumbnail starts a preview player laid over it, which would cover the
warning; while the pointer is on an unrevealed warning, that preview is held off.

**Google Docs** (`google-docs.js`): Docs draws documents on a canvas, so there's no page text to
scan or blur. Instead the extension reads the document's plain text the way File → Download →
Plain text does, using your own Google login, then shows the verdict in the same corner badge:
"Checking document…", then "Likely AI-written · 96%" or "No signs of AI · 5%". Opening it shows
the reasons and which paragraphs look AI-written, with **Check again** and **Wrong result?**. The
whole document is scored at once (more text gives a more reliable result), and the text model
reads up to 6 chunks of about 350 words. Nothing in the document is blurred, highlighted or
selected: it's usually your own document, and you may be typing. Every 15 seconds while the tab is
visible it looks for edits and re-checks once you pause. If you close the badge, it stays closed
unless an automatic re-check finds AI text. It can't read documents whose owner turned off
downloading.

## How well it works

Measured on small test sets while building this:

| | Caught | False alarms |
|---|---|---|
| Images (20 AI from Midjourney, DALL·E, Stable Diffusion; 15 real photos) | 15 / 20 | 0 / 15 |
| Text: 2022 ChatGPT answers (HC3 dataset) | 39 / 40 | 1 / 40 human answers |
| Text: ChatGPT and GPT-4 news and paper abstracts (RAID dataset) | 32 / 32 | 0 / 27 Wikipedia paragraphs from 2019 |
| Text: AI-written Wikipedia edits quoted in the guide | 15 / 18 | |
| Text: current-AI writing in a casual style | 8 / 8 | |

Text rows are for the combined check (Vanguard plus writing patterns). Before Vanguard, the
same sets gave 37/40, (not tested), 9/18 and 0/8. The guide examples were also what the
writing patterns were built from, so that row flatters the result. All the test sets are
small, and the human ones are answers and encyclopedia text, so treat these numbers as rough
and use the mistake reports to find where it goes wrong on real pages.

### Held-out test

The sets above were also used to choose the models, so they flatter the results. A separate
held-out set, never used for any choice, gives a fairer picture (default 70% threshold):

| Held-out set | Caught | False alarms |
|---|---|---|
| Images: 46 AI from Gemini, Ideogram, Craiyon, Midjourney, DALL·E, Stable Diffusion; 48 real photos (food, buildings, plants, vehicles, objects) | 37 / 46 | 1 / 48 |
| Text: 40 ChatGPT medical answers; 60 news articles from Llama-chat, Mistral-chat, Cohere-chat, MPT-chat; 90 human answers (medical, Reddit, finance) | 92 / 100 | 4 / 90 |

**Articles:** the same held-out texts of 150+ words (88 AI, 31 human), split into two-sentence
paragraphs like a blog post. Checking paragraphs one by one caught 65/88 with 2/31 false alarms;
adding the whole-article check caught 82/88 with 3/31 (the new one is a doctor's answer). Only 31
human texts were long enough, so that false-alarm rate is rough. Details:
`evaluation/results/article_check.txt`.

Weak spots it showed: all 4 text false alarms were doctors' answers to medical questions (4 of
40), it caught only 7 of 15 Cohere-chat articles, and it caught only 2 of 6 Craiyon images.

**Medical text** now needs a 0.99 score to be flagged (or the popup's threshold, if higher). A
separate tuning set of 120 doctors' and 120 ChatGPT HC3 medicine answers (none in the held-out set)
was used to choose that by a rule written before scoring; reported once on held-out it cut human
false alarms from 4 to 1 of 90 with AI catches unchanged (92/100). The tuning set shows the limit:
the current rule flagged 20 of 120 doctors' answers there, and 16 still score above 0.99, so expect
about 1 in 8 doctors' answers to be flagged anyway. Medical text is 3+ medical terms and 2+ per 100
words (`text-detector.js`). Google Docs says "Possibly AI-written" when a medical document scores
above the usual threshold but below 0.99. Details: `evaluation/results/medical_prereg.txt`.

### Across generators and writing styles

**Images** (`evaluation/data/style_images.json`: 171 AI images from 20 generators and 6 styles, 112
human-made images in 10 styles, all Wikimedia Commons thumbnails). The image model caught 126/171
and flagged 4/112 human-made ones (3 of 12 3D renders, 1 of 11 digital art; no photos, paintings,
prints, comics or line drawings). Strong on Grok, Bing Image Creator, Flux, Midjourney, DALL-E,
Imagen, Stable Diffusion, pixel art and comics (80–100%). Weak on Nano Banana 4/10, Adobe Firefly 2/7,
thispersondoesnotexist faces 2/5, Craiyon 5/10, Ideogram 3/6 and AI line drawings 1/4. Thumbnails
drop file metadata; on the original files the metadata check flags every one that carries AI
markers (all Firefly, 3/5 Gemini, 1/5 ChatGPT, 1/5 Meta AI; Nano Banana and Ideogram files had none):
`evaluation/results/style_images_metadata.txt`. Three openly licensed second image models were
tested by a rule written beforehand and none helped, so the image check is unchanged
(`evaluation/results/image_candidates_prereg.txt`).

**Text** (`evaluation/data/text_styles.json`: 535 texts. From RAID: abstracts, book summaries,
news and poems by 11 models, from GPT-2 to GPT-4, plus 11 kinds of disguise, applied to both AI
and human text. From HC3: Reddit, open questions and Wikipedia-style answers.
`evaluation/data/claude_styles.json`: 25 texts by Claude, a current model, in 25 everyday styles).
Run `python3 -I scripts/text_styles_report.py` for the full tables. Chat models were caught 95–100%,
and older base models (GPT-2, GPT-3, Cohere, Mistral) 67–75%. ChatGPT and GPT-4 were caught through
every disguise: 100% for 9 of the 11, 92% for paraphrase and 83% for zero-width spaces. Claude was
caught on 23 of 25 (missed: its poem and a personal anecdote; the poem rule makes poems even harder to catch).

The weak spot was false alarms on human text: 11 of 20 abstracts, 9 of 20 poems, 6 of 6 texts with
look-alike letters and 5 of 6 with zero-width spaces. Almost all came from the text model. Two fixes
were adopted by a rule written beforehand: thresholds were chosen on one half of the texts, then
checked once on the other half (`evaluation/results/text_styles_prereg.txt`):

- **Disguised text is cleaned first.** Invisible characters are dropped, and Cyrillic or Greek
  look-alike letters inside Latin words become Latin. This happens before both checks
  (`AIBText.normalize`). Real Russian or Greek text is left alone.
- **Research abstracts need 0.98 and poems 0.99** (`AIBText.isAcademic` / `isPoem`). Abstracts are
  recognised by research terms such as "we propose", "datasets" and "state-of-the-art". Poems are
  6+ lines, three quarters of them short, which needs the page's line breaks.

On the held-out half, human false alarms fell from 18 of 87 to 0 of 87, and AI catches went from
94.1% to 93.0%. With only 87 human texts, expect some false alarms still (95% upper bound about 3%).

### Evaluated and not adopted

Each of these was tested as a baseline on its own, and combined with the current detector using
rules fixed on the earlier sets before the held-out set was scored. Anything would only be added if
it beat the current detector on held-out data by more than chance (bootstrap 95% interval) without
adding false alarms. None did. Scripts, data and results are in `../evaluation/`.

- **[UniversalFakeDetect](https://github.com/WisconsinAIVision/UniversalFakeDetect)** (CLIP ViT-L/14
  plus a linear layer, MIT). Held-out AUC 0.51 on its own (chance level), versus 0.98 for the current
  image model; it flagged none of the Gemini or Ideogram images. Every combination scored lower than
  the current model alone (mean, weighted mean: −0.04 AUC; "either flags": +3 catches but +6 false
  alarms; "both must agree": −0.19 AUC).
- **[Binoculars](https://github.com/ahans30/Binoculars)** (BSD-3), run with the repo's own code. Its
  published setup uses two 7B models, far too big for a browser, so it was tested with the
  Qwen2.5-0.5B base/instruct pair. Held-out AUC 0.96 alone versus 0.99 for the current text check.
  No combination differed from the current check by more than chance: "either flags" gave +5
  catches and +5 false alarms, "both must agree" −10 catches and −4 false alarms. It also takes
  about 5 seconds per text on a CPU with over 1 GB of models.
- **DeepfakeBench**: not run. The link provided (`sever46/DeepfakeBench`) is an unofficial copy of
  `SCLBD/DeepfakeBench` whose setup script downloads model and pickle files from that copy, which can
  run code when loaded. The project is also non-commercial (CC BY-NC 4.0), detects face swaps only,
  and needs a face-landmark step and GPU setup that don't fit in a browser extension.

## Limits

- Image speed depends on the computer. Measured on an Apple M3: about 0.4 seconds per image on the
  graphics card (WebGPU), about 2.5 seconds on the CPU fallback (one thread), so on computers
  without WebGPU, image-heavy feeds are checked gradually.
- **YouTube thumbnails aren't checked by the image model** (anywhere they appear). Thumbnails are
  designed images, with bold text, logos and cut-outs over a photo, and the model flagged 9 of 143
  thumbnails from videos 6+ years old (6%), e.g. "How To Replace A Bicycle Chain" at 93%. Scoring
  YouTube's stills from inside the video instead removed those false alarms but also missed nearly
  every AI video (the stills are 480x360 and about 10 KB), so it wasn't adopted. AI on YouTube is
  still caught by YouTube's own AI labels, hiding videos about AI, and frames from the player
  itself. Details: `evaluation/results/youtube_thumbs_prereg.txt`.
- On Google Images the model only sees Google's thumbnails (250–550 px, re-compressed at about JPEG
  quality 75, with the file's AI metadata stripped). Shrinking held-out images that way cut catches
  from 37/46 to 32–34/46, and on 29 AI portraits from a real Google Images search the model alone
  caught 21. Results whose description mentions an AI tool ("Midjourney", "AI art", …) are flagged
  from the description regardless.
- Images are checked as they come near the screen, two model runs at a time, images ahead of text. The popup shows how many have been
  checked and how many are waiting; if the waiting number stays high, the model is probably running
  on the CPU (the popup's model line says "ready·cpu" rather than "ready·gpu").
- No detector is reliable. Expect misses and some false alarms.
- Images and videos show briefly before they're checked. Videos are only checked while they're
  playing in the active tab.
- Video frames are captured with Chrome's tab screenshot feature, which allows about 2 per second.
  That part could only be tested with simulated frame scores, not inside a real installed extension.
- Text detection is English-only.
- Hiding the AI Overview and AI videos goes by English text ("AI Overview", English titles).
  Google and YouTube change their pages often; if hiding stops working, that's the likely cause.
  Checked on live Google results (Oct 2026) and live YouTube search/watch pages. Ads on YouTube
  aren't hidden.
- Platform labels: English wording only, and the sites change their pages often. Tested on mock
  posts (`test/platform-labels-test.html`), not yet on live labeled posts: none turned up among 45
  YouTube videos checked, and Instagram and Facebook need a login. Unlabeled AI posts still rely on
  the models.

## Mistake reports

- **"Not AI?"** on any warning (and **Not AI** on the tag after revealing) un-blurs the item, stops
  blurring it in future, and saves a report.
- **Right-click → "Report as AI-generated"** on an image or video, or **"Report selected text as
  AI-written"**, blurs something the detector missed and saves a report.
- On Google Docs, **Wrong result?** on the panel saves a report with the verdict you give.
- The popup shows how many reports there are, with **Download reports** (a JSON file with the
  verdict, page, score, reasons and a text sample or media URL) and **Clear**.

Reports and the "AI / not AI" choices stay in `chrome.storage.local` on this computer
(`reports.js`). Nothing is uploaded; a user has to download and send the file themselves.
The downloaded reports are the best test set for tuning the detector on real pages.

## Trial reminders and the review question

- **Trial reminder:** with 2 days left, the popup's trial strip turns amber and the toolbar icon shows
  a small "2d" badge. Once the trial or a plan has ended, the badge is "!".
- **Trial over:** the popup and welcome page say what Sloply flagged and hid during the trial, from
  the counts below. If it found nothing, they say so without any numbers.
- **Review question:** after 20 items flagged or hidden, on a trial or a paid plan, the popup asks once.
  Either answer ends it, and it stops by itself after 3 popup openings. It stays away while a model
  has failed. The link only goes to the store's reviews page; nothing is sent.

## Weekly summary and never-check sites

- **This week** (popup → the Mistakes line) opens a page with what was flagged or hidden in the last
  7 days: totals for images, videos, text and hidden AI answers/videos, a bar chart per day (hover
  or focus a day for details, or switch to a table), the top sites, and mistake reports. Only counts
  are kept, per site and day, for 8 weeks, in `chrome.storage.local` (`activity.js`): no page
  addresses, images or text. The background worker is the only writer, so tabs can't overwrite each
  other's counts.
- **Never check these sites** (settings page): nothing is blurred, flagged or hidden there. An entry
  covers its subdomains ("example.com" also covers www. and blog.), full addresses are reduced to the
  host name, and the popup's **Pause** / **Resume** use the same list (`sites.js`).

## Text model

`models/ShantanuT01/vanguard-ai-text-detector/` holds an ONNX export of
[ShantanuT01/vanguard-ai-text-detector](https://huggingface.co/ShantanuT01/vanguard-ai-text-detector)
(MIT license), with 4-bit matrix weights and an 8-bit word table (`model_q4g8.onnx`, 268 MB).
It was chosen after testing 8 open AI-text classifiers: the others either missed casual text or
flagged about half of the human-written Wikipedia paragraphs. Shrinking it didn't change its
results on the test sets. The [lynote-ai/ai-text-detector](https://github.com/lynote-ai/ai-text-detector)
repo was also checked: it ships only rule-based heuristics (its own HC3 evaluation flags almost
no ChatGPT text) and no trained model weights, so nothing from it was used.

To rebuild it (Python 3.12):

```bash
optimum-cli export onnx --model ShantanuT01/vanguard-ai-text-detector --task text-classification out/
python -c "import onnx; from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer as Q; q = Q(onnx.load('out/model.onnx'), block_size=32, is_symmetric=True); q.process(); q.model.save_model_to_file('out/model_q4.onnx')"
python -c "from onnxruntime.quantization import quantize_dynamic, QuantType; quantize_dynamic('out/model_q4.onnx', 'out/model_q4g8.onnx', weight_type=QuantType.QUInt8, op_types_to_quantize=['Gather'])"
```

Then put `model_q4g8.onnx` in `onnx/` and copy the JSON files next to it.

## Image model

`models/haywoodsloan/ai-image-detector-deploy/` holds a 4-bit ONNX export of
[haywoodsloan/ai-image-detector-deploy](https://huggingface.co/haywoodsloan/ai-image-detector-deploy)
(Apache 2.0, so commercial use is allowed). It was chosen over 11 other permissively licensed
detectors in testing. Its `config.json` says `"model_type": "swin"` instead of `swinv2` because
Transformers.js has no SwinV2 class; the exported graph is complete, so this only changes which
wrapper feeds it pixels. The model card doesn't say what images it was trained on.

To rebuild it (Python 3.12):

```bash
pip install torch transformers "optimum[onnxruntime]"
optimum-cli export onnx --model haywoodsloan/ai-image-detector-deploy --task image-classification out/
pip install onnx-ir
python -c "import onnx; from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer as Q; q = Q(onnx.load('out/model.onnx'), block_size=32, is_symmetric=True); q.process(); q.model.save_model_to_file('out/model_q4.onnx')"
```

Then put `model_q4.onnx` in `onnx/`, copy the two JSON files, and set `model_type` to `swin`.

### Speed

Measured on an Apple M3 (median time per image, same scores in every setup):

| Setup | Time per image |
|---|---|
| CPU, 1 thread, 8-bit model (before) | 2,132 ms |
| CPU, 4 threads, 8-bit | 659 ms |
| CPU, 4 threads, 4-bit | 803 ms |
| **Graphics card (WebGPU), 4-bit (now)** | **~390 ms** |
| Graphics card, full-precision model (783 MB, too big to ship) | 220 ms |

The 4-bit model is the only version that's fast on both: 8-bit ops fall back to the CPU on WebGPU.
More CPU threads would also help the fallback, but they need the extension's pages to be
cross-origin isolated (`cross_origin_embedder_policy` in the manifest). That's untested here,
because it could stop the model page from loading images from other sites.

### When the models can't load

If a model fails to download (no connection, a blocked host) or its download stops making progress
for 90 seconds, Sloply says so instead of treating everything as "not AI":
- The popup shows **Detection models didn't load / Only basic checks for now** in place of the
  counts, with **Try again** (it closes the models page, resets the status and loads the models
  again, showing the download). Hovering the warning shows the error.
- Pages show a notice once ("Sloply couldn't load its detection models…"), at most every 10
  minutes across tabs.
- Meanwhile the basic checks keep running: image metadata, captions and alt text, platform labels
  and the writing patterns. Failed results aren't cached, so pages are checked again properly once
  the models work. An image that can't be downloaded by itself doesn't count as a model failure.
Tested by `test/model-errors-test.html` (missing files, a stalled download, the page notice) and
`test/model-errors-node-test.js` (the background worker and Try again).

### Memory

The models page holds both models (several hundred MB) while it's open. After 10 minutes without
any checks it closes itself to give that memory back, and the next check opens it again (a few
seconds to reload the models). It never closes while a check is running; a check that arrives while
it's closing waits for a fresh one. The popup's model line goes back to "idle" when it closes.
Tested with `test/idle-unload-test.js` (`node test/idle-unload-test.js`).

### Pipeline

Each image is downloaded once, in the model page, which checks its metadata and its pixels from
the same bytes (before, the background worker downloaded it for the metadata and the model page
downloaded it again). Model runs go through one queue, two at a time, with images and video
frames ahead of text. Measured with 12 web images and 12 text passages submitted at once
(`test/pipeline-bench.html`, details in `evaluation/results/pipeline_speed.txt`):

| | Before | Now |
|---|---|---|
| Half the images done | 7.9 s | 3.5 s |
| All images done | 7.9 s | 5.1 s |
| All text done | 3.7 s | 8.2 s |
| Whole batch | 7.9 s | 8.2 s |
| Image requests | 24 | 12 |

Text now waits for images, so it finishes later, and the whole batch takes about 4% longer. The
second download used to come from the browser cache, so it cost requests rather than data; it
only cost data for images over 1 MB or ones a site marks as uncacheable.

## Tests

```bash
node test/run-all.mjs
```

Opens every test page in headless Chrome and runs the Node tests, with no installs (it uses the
Chrome on this computer and Node's built-in WebSocket); about 40 seconds. `node test/run-all.mjs
hiding` runs only the suites whose name contains "hiding". Pages report through
`window.__results` / `window.__done`. For evaluations, `test/text-scores.html` scores a text file
with the extension's own checks and `--save DIR` writes the scores out.

## Files

| File | What it does |
|---|---|
| `manifest.json` | Extension config (Manifest V3) |
| `content.js` | Scans the page, samples video frames, blurs flagged images and videos, lists AI text in the badge |
| `content.css` | Blur styles |
| `text-detector.js` | Fast phrase-based text check |
| `metadata.js` | AI signals in image file metadata (shared by the background worker and the model page) |
| `options.html` / `options.js` | Settings page: your own words and allowed channels for hiding YouTube videos about AI |
| `sites.js` | The never-check list: matching sites and subdomains |
| `activity.js` | Weekly counts of what was flagged or hidden (per site and day) |
| `summary.html` / `summary.js` | The weekly summary page |
| `reports.js` | Mistake reports and remembered "AI / not AI" choices |
| `platform-labels.js` | Finds YouTube, Instagram, Facebook, TikTok and Pinterest's own AI labels |
| `hiding.js` | Finds Google's AI Overview and YouTube videos about AI |
| `badge.js` | The corner badge for AI-written text, on web pages and in Google Docs |
| `google-docs.js` | Checks Google Docs documents and shows the result in the badge |
| `background.js` | Reads image metadata, captures video frames, routes work to the models |
| `offscreen.html` / `models.js` | Hidden page that runs the image and text models |
| `lib/` | Transformers.js and ONNX Runtime, the libraries that run the models (see `lib/NOTICE.txt`) |
| `models/` | The image and text models (left out of the store build, which downloads them) |
| `icons/` | Extension icons; `make-icons.mjs` writes their SVG sources (rendered to PNG with headless Chrome) |
| `popup.html` / `popup.js` | Settings: on/off, blur or remove, images/videos/text, hiding, threshold, models, per-site off, mistake reports |
| `test/test-page.html` | Demo page with AI and human examples |
| `test/models-test.html` | Runs the models outside the extension, for testing (`?nogpu` tests the CPU fallback) |
| `test/speed-test.html` | Times the image model with different devices, thread counts and model versions |
| `test/platform-labels-test.html` | Mock labeled and unlabeled posts for each platform; checks which get blurred |
| `test/hiding-test.html` | Mock Google results and YouTube feed; checks what gets hidden |
| `test/article-test.html` | Mock blog posts with short paragraphs (AI and human), for the article check |
| `test/article-eval.html` | Measures the article check on the held-out texts (`article-eval-data.json`) |
| `test/pipeline-bench.html` | Times a burst of images and text through the model page, before (`test/models-before.js`) and now |
| `test/docs-test.html` | Runs the Google Docs check on a mock document (real text model; `?nomodel` for patterns only) |
| `test/thumb-eval.html` | Scores the YouTube thumbnail set (`youtube-thumbs.json`, from `evaluation/scripts/collect_youtube_thumbs.py`) |
| `test/run-all.mjs` | Runs all the tests below in headless Chrome and Node |
| `test/sites-test.html` / `test/ai-features-test.html` / `test/summary-test.html` | Never-check list; AI answers in Google, Bing and DuckDuckGo; weekly summary |
| `test/trial-end-test.js` / `test/activity-test.js` / `test/medical-test.js` / `test/text-styles-test.js` / `test/license-dev-test.js` / `test/license-token-test.js` | Node tests: trial-end counts and the review question's rules; summary counts from several tabs; the medical threshold; cleaning disguised text and the abstract and poem thresholds; the unpacked developer unlock; signed licenses |
| `test/text-scores.html` | Scores a file of texts with the extension's text checks (for evaluations) |
| `test/idle-unload-test.js` | Node test: the models page closes when idle, never mid-check, and reopens for the next check |
| `test/remove-test.html` | Remove mode on grids, figures, articles, pin cards, side-by-side images and a hero |
| `test/model-errors-test.html` / `test/model-errors-node-test.js` | Models that can't load: missing files, stalled download, page notice, popup and Try again |
| `test/image-scores.html` / `test/candidate-image-scores.html` | Score a file of images with the extension's check, or with another model (for evaluations) |
