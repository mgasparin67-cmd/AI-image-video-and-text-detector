// Tests the fixes for disguised text, research abstracts and poems (text-detector.js). The rules and
// their evaluation: evaluation/results/text_styles_prereg.txt. Run from the ai-blocker folder:
// node test/text-styles-test.js
const { normalize, isAcademic, isPoem, threshold, score } = require('../text-detector.js');
const results = [];
const check = (name, ok) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };

check('drops zero-width spaces, joiners and soft hyphens', normalize('H​i‌g‍h⁠-­q﻿uality') === 'High-quality');
check('maps Cyrillic and Greek look-alikes inside Latin words', normalize('Ηіgh-quаlіtу trаіnіng dаtа') === 'High-quality training data');
check('maps them next to accented Latin letters', normalize('cаfé') === 'café');
check('leaves real Russian and Greek alone', normalize('Привет мир') === 'Привет мир' && normalize('Καλημέρα κόσμε') === 'Καλημέρα κόσμε');
const ai = 'Moreover, this vibrant tapestry serves as a testament to the enduring legacy of the region, highlighting its pivotal role. ' +
  'Furthermore, it underscores the intricate interplay between tradition and innovation, fostering a rich landscape of ideas. ' +
  'In conclusion, it is important to note that this showcases the profound significance of the community.';
const disguised = ai.replace(/a/g, 'а').replace(/o/g, 'о').split('').join('​');
check('disguised text scores like the plain text', score(disguised).score === score(ai).score && score(ai).score > 0.5);

const abstract = 'In this paper, we propose a novel framework for interactive image segmentation. Experiments on three ' +
  'benchmark datasets show that our method outperforms state-of-the-art baselines.';
const news = 'The council voted on Tuesday to close the bridge for repairs. Residents said the detour would add twenty ' +
  'minutes to their drive, and shop owners worried about losing customers over the summer.';
check('a research abstract counts as academic', isAcademic(abstract));
check('a news story does not', !isAcademic(news));
check('an abstract with look-alike letters still counts', isAcademic(abstract.replace(/e/g, 'е')));

const poem = 'There is a power whose inspiration fills\nNature\'s fair fabric, sun- and star-inwrought,\nLike airy dew ere any drop distils,\n' +
  'Like perfume in the laden flower, like aught\nUnseen which interfused throughout the whole\nBecomes its quickening pulse and principle and soul.';
check('a poem counts as a poem', isPoem(poem));
check('the same lines without line breaks do not', !isPoem(poem.replace(/\n/g, ' ')));
check('prose paragraphs do not', !isPoem([news, news, news, news, news, news].join('\n')));

check('abstracts need 0.98 at the default 0.7', threshold(abstract, 0.7) === 0.98);
check('poems need 0.99 at the default 0.7', threshold(poem, 0.7) === 0.99);
check('other text keeps the popup threshold', threshold(news, 0.7) === 0.7);
console.log(results.every(Boolean) ? `ALL ${results.length} PASS` : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
