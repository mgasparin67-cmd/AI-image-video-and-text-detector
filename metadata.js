// AI signals inside an image file's own bytes (metadata). Shared by the model page, which checks
// the bytes it already downloaded for the model, and the background worker, which checks images
// on its own when the models are turned off.

(function (root) {
  const MAX_BYTES = 1024 * 1024; // metadata lives near the start of the file

  const SIGNALS = [
    // IPTC "digital source type", written by OpenAI, Google, Adobe, Meta and others.
    { re: /compositeWithTrainedAlgorithmicMedia/, score: 0.85, reason: 'Metadata says the image was partly made with AI' },
    { re: /trainedAlgorithmicMedia/, score: 0.97, reason: 'Metadata says the image was made with AI' },
    // Stable Diffusion (Automatic1111 / Forge) stores its settings in a PNG text chunk.
    { re: /parameters[\s\S]{0,6000}?Steps: \d+[\s\S]{0,400}?Sampler:/, score: 0.96, reason: 'Contains Stable Diffusion generation settings' },
    // ComfyUI stores its node graph as JSON.
    { re: /"class_type"\s*:\s*"[A-Za-z]+/, score: 0.95, reason: 'Contains a ComfyUI workflow' },
    // Generator names inside Content Credentials (C2PA) or XMP.
    { re: /(DALL[·\-·]?E|Midjourney|Adobe Firefly|Stable Diffusion|NovelAI|Leonardo\.Ai|Ideogram|Google Imagen|ChatGPT|OpenAI)/i, score: 0.8, reason: 'Metadata mentions an AI image generator' }
  ];

  // bytes: the start of the file (Uint8Array).
  function scan(bytes) {
    const text = new TextDecoder('latin1').decode(bytes.subarray(0, MAX_BYTES));
    for (const s of SIGNALS) {
      if (s.re.test(text)) return { score: s.score, reasons: [s.reason], source: 'metadata' };
    }
    return { score: 0, reasons: [] };
  }

  root.AIBMetadata = { MAX_BYTES, scan };
})(self);
