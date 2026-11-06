// Tests the stricter threshold for medical text (text-detector.js). The rule and its evaluation:
// evaluation/results/medical_prereg.txt. Run from the ai-blocker folder: node test/medical-test.js
const { isMedical, threshold } = require('../text-detector.js');
const results = [];
const check = (name, ok) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); };

const doctor = 'Hi, thanks for your query. Your symptoms suggest a viral infection. Take paracetamol 500 mg for the fever, ' +
  'drink plenty of fluids, and consult your doctor if the nausea or vomiting continues for more than two days.';
const recipe = 'Bring a pot of water to a boil, lower the eggs in gently, and cook for ten minutes. ' +
  'Move them to cold water, peel, and season with salt and pepper before serving.';
const passing = 'My doctor said it was fine. We talked about the weather, the traffic, the new cafe on the corner, ' +
  'and a dozen other things for most of the afternoon before I went home and made dinner for everyone.';

check('a doctor\'s answer counts as medical', isMedical(doctor));
check('a recipe does not', !isMedical(recipe));
check('one passing mention of a doctor does not', !isMedical(passing));
check('medical text needs 0.99 at the default 0.7', threshold(doctor, 0.7) === 0.99);
check('other text keeps the popup threshold', threshold(recipe, 0.7) === 0.7 && threshold(recipe, 0.85) === 0.85);
check('a popup threshold above 0.99 still applies', threshold(doctor, 0.995) === 0.995);
console.log(results.every(Boolean) ? `ALL ${results.length} PASS` : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
