// Local, offline guess at whether a block of text was written by an AI chatbot.
// The signs come from Wikipedia's field guide "Signs of AI writing"
// (https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing): overused "AI vocabulary",
// puffed-up significance, tacked-on "-ing" analysis, negative parallelisms, chatbot
// leftovers, and so on. It also counts the guide's signs of *human* writing against the score.
// This is a heuristic, not proof, and needs a decent amount of text to say anything.

(function (root) {
  const MIN_WORDS = 50;

  // Overused words, by the chatbot "era" the guide associates them with. Taken literally:
  // only these exact words, not their synonyms. Several distinct ones together is a strong sign.
  const AI_VOCAB = [
    // 2023 to mid-2025 (GPT-4, GPT-4o)
    /^additionally$/, /^align(s|ed|ing)?$/, /^boast(s|ed|ing)?$/, /^bolster(ed|s|ing)?$/, /^crucial(ly)?$/,
    /^delv(e|es|ed|ing)$/, /^emphasiz(e|es|ed|ing)$/, /^enduring$/, /^enhanc(e|es|ed|ing)$/,
    /^foster(s|ed|ing)?$/, /^garner(s|ed|ing)?$/, /^highlight(s|ed|ing)?$/, /^interplay$/,
    /^intricate$/, /^intricacies$/, /^landscape$/, /^meticulous(ly)?$/, /^pivotal$/, /^robust$/,
    /^showcas(e|es|ed|ing)$/, /^tapestry$/, /^testament$/, /^underscor(e|es|ed|ing)$/,
    /^valuable$/, /^vibrant$/,
    // mid-2026 and on (GPT-6)
    /^dependable$/, /^echoed$/, /^leverag(e|es|ed|ing)$/, /^multifaceted$/, /^prioritiz(e|es|ed|ing)$/,
    /^quietly$/, /^universally$/
  ];

  // [category, reason shown to the user, weight, patterns]
  const SIGNS = [
    ['significance', 'Puffs up significance or legacy', 2, [
      /\b(stands|serves) as an?\b/gi,
      /\bis an? (testament|reminder)\b/gi,
      /\ban? (crucial|pivotal|vital|significant|key) (role|moment)\b/gi,
      /\b(underscor|highlight)(es|s|ing) (its|their|the) (importance|significance)\b/gi,
      /\breflect(s|ing)? (a )?broader\b/gi,
      /\bsymboliz(es|ing) (its|their|the) (ongoing|enduring|lasting)\b/gi,
      /\bsetting the stage for\b/gi,
      /\b(marking|shaping) the\b/gi,
      /\b(represents|marks|marked|represented) an? (significant |major |pivotal )?shift\b/gi,
      /\bkey turning point\b/gi, /\bevolving landscape\b/gi, /\bfocal point\b/gi,
      /\bindelible mark\b/gi, /\bdeeply rooted\b/gi,
      /\b(generated|sparked|prompted) (broader |public |ongoing )?(debate|discussion|reflection)s?\b/gi,
      /\b(broader|public|policy) (debates?|discussions|reflection)\b/gi,
      /\braising (\w+ )?questions about\b/gi
    ]],
    ['connection', 'Vague "associated with" links', 0.75, [
      /\b(in connection with|connected (with|to)|in association with|associated with)\b/gi
    ]],
    ['markdown', 'Pasted chatbot formatting', 2, [
      /\*\*[^*\n]{2,60}\*\*/g, /(^|\s)#{2,3} [A-Z]/g
    ]],
    ['superficial', 'Tacks on vague "-ing" commentary', 1.5, [
      /, (highlighting|underscoring|emphasizing|ensuring|reflecting|symbolizing|contributing to|cultivating|fostering|encompassing|enhancing|showcasing)\b/gi,
      /\bvaluable insights\b/gi, /\bresonat(e|es|ing) with\b/gi
    ]],
    ['promotional', 'Reads like an advert', 1, [
      /\bboasts an?\b/gi, /\bnestled\b/gi, /\bin the heart of\b/gi, /\bgroundbreaking\b/gi,
      /\brenowned\b/gi, /\bnatural beauty\b/gi, /\bcommitment to\b/gi,
      /\b(diverse|rich|wide) (array|range|tapestry) of\b/gi, /\brich (cultural )?heritage\b/gi,
      /\bexemplif(y|ies)\b/gi, /\bprofound\b/gi
    ]],
    ['notability', 'Name-drops media coverage', 2, [
      /\bindependent coverage\b/gi, /\b(local|regional|national|prominent|major) media outlets\b/gi,
      /\btrade publications\b/gi, /\b(featured|profiled) in\b/gi, /\bactive social media presence\b/gi
    ]],
    ['vague-attribution', 'Vague "experts say" sourcing', 1.5, [
      /\bindustry reports\b/gi, /\bobservers have (cited|noted)\b/gi,
      /\bexperts (argue|say|note|suggest|believe)\b/gi, /\bsome critics (argue|say|note)\b/gi
    ]],
    ['challenges', 'Formulaic "challenges and future" wrap-up', 2, [
      /\bdespite (its|these|their|the|such) [^.]{0,40}?challenges\b/gi, /\bfaces several challenges\b/gi,
      /\bfuture outlook\b/gi
    ]],
    ['copula', 'Avoids plain "is" ("serves as", "functions as")', 1, [
      /\b(functions|operates) as an?\b/gi, /\b(features|offers|maintains) an?\b/gi
    ]],
    ['parallelism', '"Not X, but Y" contrasts', 1.5, [
      /\bnot (just|only|merely) [^.]{1,60}?,? but (also )?/gi,
      /\bnot [^.,;]{1,40}?,? but (in|rather|instead)\b/gi,
      /\b(it'?s|it is|this is|that'?s) not [^.]{1,40}?[,;] (it'?s|it is)\b/gi,
      /\bno [^.,]{1,20}, no [^.,]{1,20}, just\b/gi
    ]],
    ['hedging', 'Hedging disclaimers about sources', 2.5, [
      /\bwhile specific details (are|remain) (limited|scarce)\b/gi,
      /\bnot widely (available|documented|disclosed)\b/gi,
      /\bin the (provided|available) (sources|search results)\b/gi,
      /\bbased on (the )?available information\b/gi,
      /\bdoes not by itself establish\b/gi,
      /\bshould be (treated|presented|read|understood) as [^.]{1,60}? rather than\b/gi,
      /\bshould not be confused with\b/gi
    ]],
    ['chatbot', 'Leftover chatbot talk', 4, [
      /\bI hope this helps\b/gi, /\bof course!/gi, /\bcertainly!/gi, /\byou'?re absolutely right\b/gi,
      /\bwould you like (me to|a|an)\b/gi, /\bis there anything else\b/gi, /\blet me know if\b/gi,
      /\bmore detailed breakdown\b/gi, /\bhere'?s an? (quick |brief )?(breakdown|overview|summary)\b/gi,
      /\bas an AI( language model)?\b/gi, /\bas a large language model\b/gi,
      /\bas of my (last|latest) (knowledge|training) (update|cutoff)\b/gi, /\bup to my last training\b/gi,
      /\bgreat question\b/gi
    ]],
    ['summary', 'Ends with a canned summary', 1.5, [
      /(^|[.!?] )(in summary|in conclusion|overall|to sum up),/gi
    ]],
    ['dated-tells', 'Old ChatGPT stock phrases', 2, [
      /\bit'?s (important|worth|crucial|essential) (to note|noting|to remember|to consider)\b/gi,
      /\bin (today's|the) (fast-paced|ever-evolving|ever-changing|digital|modern) (world|landscape|age|era)\b/gi,
      /\bnavigat(e|es|ing) the (complexities|intricacies)\b/gi,
      /\bwhether you'?re [^.]{1,60}? or\b/gi,
      /\b(unlock(s|ing)? the (power|potential|secrets)|game[- ]changer)\b/gi
    ]]
  ];

  // The guide's signs of human writing (Wikipedia, 25 years of articles).
  const HUMAN_SIGNS = [
    /\bthere (is|are|was|were) an?\b/gi, /\b(it|he|she|they) (has|had) an?\b/gi,
    /\b(wrote|moved|used|tried|died)\b/gi,
    /\bone of the (best|worst|first|largest|most)\b/gi, /\b(is|was) the (only|first|last)\b/gi,
    /\b(very|perhaps|tends to|probably|maybe)\b/gi,
    /\b(as a result of|in order to|all of the|a part of|the fact that)\b/gi,
    // casual chat
    /\b(lol|lmao|tbh|imo|idk|gonna|wanna|kinda|yeah|nah|ugh|haha)\b/gi, /!!|\?\?|\.\.\./g
  ];

  function score(text) {
    const clean = normalize(text).replace(/\s+/g, ' ').trim();
    const words = clean.split(' ').filter(Boolean);
    if (words.length < MIN_WORDS) return { score: 0, reasons: [] };
    const per100 = 100 / words.length;
    const found = [];

    // 1. Pattern signs
    let signWeight = 0;
    for (const [, reason, weight, patterns] of SIGNS) {
      const hits = patterns.flatMap(re => clean.match(re) || []);
      if (hits.length) {
        signWeight += hits.length * weight;
        found.push({ weight: hits.length * weight, text: `${reason} ("${hits[0].replace(/^[,.!? ]+/, '').trim()}")` });
      }
    }

    // 2. AI vocabulary: distinct words matter more than repeats.
    const vocab = new Set();
    for (const w of words) {
      const lw = w.toLowerCase().replace(/[^a-z-]/g, '');
      if (AI_VOCAB.some(re => re.test(lw))) vocab.add(lw);
    }
    const vocabScore = vocab.size >= 2 ? (vocab.size - 1) ** 1.3 : 0;
    if (vocab.size >= 3) found.push({ weight: vocabScore * 1.5, text: `${vocab.size} overused "AI words" (${[...vocab].slice(0, 4).join(', ')})` });

    // 3. Punctuation habits. Em dashes are a fading sign (newer chatbots avoid them),
    //    so they count for little; mixed curly and straight quotes count a bit.
    const dashes = (clean.match(/ — /g) || []).length + 0.5 * (clean.match(/\S—\S/g) || []).length;
    const dashDensity = dashes * per100;
    if (dashDensity >= 1) found.push({ weight: dashDensity, text: 'Lots of em dashes' });
    const mixedQuotes = /[“”‘’]/.test(clean) && /["']/.test(clean) ? 1 : 0;
    if (mixedQuotes) found.push({ weight: 1, text: 'Mixes curly and straight quotes' });

    // 4. "X, Y, and Z" lists (rule of three)
    const triads = (clean.match(/\b[\w-]+( [\w-]+)?, [\w-]+( [\w-]+)?,? and [\w-]+/g) || []).length * per100;

    // 5. Even sentence lengths, and (in newer chatbots) little punctuation beyond commas and periods.
    const sentences = clean.split(/(?<=[.!?])\s+/).map(s => s.split(' ').length).filter(n => n >= 3);
    let uniformity = 0;
    if (sentences.length >= 4) {
      const mean = sentences.reduce((a, b) => a + b, 0) / sentences.length;
      const sd = Math.sqrt(sentences.reduce((a, b) => a + (b - mean) ** 2, 0) / sentences.length);
      uniformity = Math.min(1, Math.max(0, (0.5 - sd / mean) / 0.3));
      const plainPunctuation = !/[;:()?!]/.test(clean) && sentences.every(n => n >= 6 && n <= 22);
      if (plainPunctuation) uniformity = Math.min(1, uniformity + 0.3);
      if (uniformity > 0.6) found.push({ weight: uniformity, text: 'Sentences are unusually even in length' });
    }

    // 6. Signs of human writing
    const human = HUMAN_SIGNS.reduce((n, re) => n + (clean.match(re) || []).length, 0) * per100;

    // Weights tuned on human text (HC3 answers, 2019 Wikipedia) vs AI text (HC3 ChatGPT,
    // the guide's own examples). The human signs are a weak, Wikipedia-specific tell, so they
    // only pull the score down a little.
    // Signs are measured per 100 words, but short texts are treated as at least 120 words
    // so a single stock phrase in a short comment isn't enough on its own.
    const signRate = signWeight * (100 / Math.max(words.length, 120));
    const z = -3.0
      + 2.2 * Math.min(signRate, 4)
      + 1.0 * Math.min(vocabScore, 4)
      + 0.3 * Math.min(dashDensity, 4)
      + 0.3 * mixedQuotes
      + 0.2 * Math.min(triads, 4)
      + 1.0 * uniformity
      - 0.2 * Math.min(human, 6);
    const s = 1 / (1 + Math.exp(-z));
    const features = { signs: signRate, vocab: vocabScore, dashes: dashDensity, mixedQuotes, triads, uniformity, human };
    const reasons = found.sort((a, b) => b.weight - a.weight).slice(0, 3).map(f => f.text);
    return { score: Math.round(s * 100) / 100, reasons, features };
  }

  // ---------- Medical text ----------
  // Doctors' answers often read like AI to both checks: on held-out data all 4 human false alarms
  // were doctors' answers. Medical text therefore needs a 0.99 score to be flagged. Chosen on a
  // separate tuning set and confirmed on held-out (false alarms 4 -> 1 of 90, AI catches unchanged):
  // evaluation/results/medical_prereg.txt. Same terms and cut-offs as evaluation/scripts/medical.py.
  const MEDICAL_TERMS = /\b(doctors?|physicians?|patients?|symptoms?|treatments?|treated|diagnos(is|ed|e)|medications?|medicines?|doses?|dosage|infections?|diseases?|surgery|surgical|prescri(be|bed|ption)s?|clinic(al)?|hospital|therapy|chronic|inflammation|antibiotics?|cancer|tumou?rs?|virus|viral|bacteria|bacterial|kidneys?|liver|pregnan(t|cy)|allerg(y|ies|ic)|diabetes|cholesterol|blood pressure|x-?ray|mri|ultrasound|healthcare|health care|mg|tablets?|nausea|fever|vomiting|specialist|consult(ation)?)\b/gi;
  const MEDICAL_THRESHOLD = 0.99;

  // 3+ medical terms and 2+ per 100 words.
  function isMedical(text) {
    const words = String(text).split(/\s+/).filter(Boolean).length;
    const hits = (String(text).match(MEDICAL_TERMS) || []).length;
    return hits >= 3 && (hits * 100) / Math.max(words, 1) >= 2;
  }


  // ---------- Disguised text ----------
  // Invisible characters and look-alike letters from other alphabets make text unreadable to both
  // checks (evaluation/results/text_styles_prereg.txt). Drop the first, map the second to Latin.
  const INVISIBLE = /[​-‍⁠﻿­]/g;
  const LOOKALIKE = {
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'Ѕ': 'S', 'І': 'I', 'Ј': 'J',
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'һ': 'h', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w',
    'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
    'ο': 'o', 'ν': 'v', 'ι': 'i'
  };
  const LOOKALIKE_RE = new RegExp('[' + Object.keys(LOOKALIKE).join('') + ']', 'g');
  // Only swaps letters inside words that are mostly Latin, so real Greek or Russian text is left alone.
  function normalize(text) {
    return String(text).replace(INVISIBLE, '').replace(/\S+/g, w => {
      const latin = (w.match(/\p{Script=Latin}/gu) || []).length;
      const swaps = (w.match(LOOKALIKE_RE) || []).length;
      return swaps && latin + swaps >= w.replace(/[^\p{L}]/gu, '').length ? w.replace(LOOKALIKE_RE, c => LOOKALIKE[c]) : w;
    });
  }

  // ---------- Genres that read like AI ----------
  // Human research abstracts and poems are often flagged, mostly by the text model. Designed on the
  // tuning half of evaluation/data/text_styles.json only.
  const ACADEMIC_TERMS = /\b(this (paper|work|study|article|thesis)|in this (paper|work|study|article)|we (propose|present|introduce|show|demonstrate|develop|investigate|study|evaluate|analy[sz]e|report)|our (method|approach|model|framework|results|experiments|analysis)|(the|a) (proposed|novel) (method|approach|model|framework|technique|algorithm)|state[- ]of[- ]the[- ]art|experiments?|experimental|results (show|demonstrate|indicate|suggest)|datasets?|benchmarks?|outperform(s|ed)?|frameworks?|algorithms?|empirical(ly)?|theoretical(ly)?|methodology|baselines?|methods?|approach(es)?|et al)\b/gi;
  const isAcademic = text => (normalize(text).match(ACADEMIC_TERMS) || []).length >= 3;
  // Needs the text's line breaks (innerText, not textContent): 6+ lines, three quarters of them short.
  function isPoem(text) {
    const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
    return lines.length >= 6 && lines.filter(l => l.length <= 60).length >= lines.length * 0.75;
  }

  // Chosen on the tuning half and confirmed on held-out (human false alarms 18 -> 0 of 87, AI caught
  // 94.1% -> 93.0%): evaluation/results/text_styles_prereg.txt.
  const ACADEMIC_THRESHOLD = 0.98;
  const POEM_THRESHOLD = 0.99;

  // The score a text needs to be flagged, given the popup's threshold. Pass the text with its line
  // breaks so poems can be recognised.
  function threshold(text, base) {
    let t = base;
    if (isMedical(text)) t = Math.max(t, MEDICAL_THRESHOLD);
    if (isAcademic(text)) t = Math.max(t, ACADEMIC_THRESHOLD);
    if (isPoem(text)) t = Math.max(t, POEM_THRESHOLD);
    return t;
  }

  root.AIBText = { score, isMedical, threshold, normalize, isAcademic, isPoem };
  if (typeof module !== 'undefined') module.exports = { score, isMedical, threshold, normalize, isAcademic, isPoem };
})(typeof window !== 'undefined' ? window : globalThis);
