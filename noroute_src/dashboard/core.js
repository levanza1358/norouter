const $ = (id) => document.getElementById(id);

const REFRESH_MS = 2000;

const THEME_KEY = 'norouter.theme';
let motionEpoch = 0;

function staggerChildren(host, selector, key) {
  if (!host || host.dataset.motionKey === key) return;
  host.dataset.motionKey = key;
  host.querySelectorAll(selector).forEach((item, index) => {
    item.style.setProperty('--motion-index', Math.min(index, 12));
    item.classList.add('motion-stagger');
  });
}

function moveTabIndicator(host, selector = '[role="tab"].is-active') {
  if (!host) return;
  const active = host.querySelector(selector);
  if (!active) return;
  const paint = () => {
    host.style.setProperty('--tab-left', `${active.offsetLeft}px`);
    host.style.setProperty('--tab-width', `${active.offsetWidth}px`);
  };
  paint();
  if (!active.offsetWidth) requestAnimationFrame(paint);
}

const ACCENT_KEY = 'norouter.accent';

const REPLY_LANGUAGE_CATALOG = [
  ['auto', 'Auto', 'Match user prompt', '🌐'], ['none', 'None', 'No language instruction', '⊘'], ['af', 'Afrikaans', 'Afrikaans', 'za'],
  ['am', 'አማርኛ', 'Amharic', 'et'], ['ar', 'العربية', 'Arabic', 'sa'], ['az', 'azərbaycan dili', 'Azerbaijani', 'az'],
  ['bg', 'български език', 'Bulgarian', 'bg'], ['bn', 'বাংলা', 'Bengali', 'bd'], ['bs', 'bosanski jezik', 'Bosnian', 'ba'],
  ['ca', 'català', 'Catalan', 'es'], ['cs', 'čeština', 'Czech', 'cz'], ['cy', 'Cymraeg', 'Welsh', 'gb-wls'],
  ['da', 'dansk', 'Danish', 'dk'], ['de', 'Deutsch', 'German', 'de'], ['el', 'Ελληνικά', 'Greek', 'gr'],
  ['en', 'English', 'English', 'gb'], ['es', 'Español', 'Spanish', 'es'], ['et', 'eesti', 'Estonian', 'ee'],
  ['eu', 'euskara', 'Basque', 'es'], ['fa', 'فارسی', 'Persian', 'ir'], ['fi', 'suomi', 'Finnish', 'fi'],
  ['fr', 'Français', 'French', 'fr'], ['ga', 'Gaeilge', 'Irish', 'ie'], ['gl', 'galego', 'Galician', 'es'],
  ['gu', 'ગુજરાતી', 'Gujarati', 'in'], ['ha', 'Hausa', 'Hausa', 'ng'], ['he', 'עברית', 'Hebrew', 'il'],
  ['hi', 'हिन्दी', 'Hindi', 'in'], ['hr', 'hrvatski', 'Croatian', 'hr'], ['hu', 'magyar', 'Hungarian', 'hu'],
  ['hy', 'հայերեն', 'Armenian', 'am'], ['id', 'Bahasa Indonesia', 'Indonesian', 'id'], ['is', 'íslenska', 'Icelandic', 'is'],
  ['it', 'Italiano', 'Italian', 'it'], ['ja', '日本語', 'Japanese', 'jp'], ['jv', 'Basa Jawa', 'Javanese', 'id'],
  ['ka', 'ქართული', 'Georgian', 'ge'], ['kk', 'қазақ тілі', 'Kazakh', 'kz'], ['km', 'ខ្មែរ', 'Khmer', 'kh'],
  ['kn', 'ಕನ್ನಡ', 'Kannada', 'in'], ['ko', '한국어', 'Korean', 'kr'], ['ky', 'кыргызча', 'Kyrgyz', 'kg'],
  ['la', 'latine', 'Latin', 'va'], ['lo', 'ລາວ', 'Lao', 'la'], ['lt', 'lietuvių kalba', 'Lithuanian', 'lt'],
  ['lv', 'latviešu valoda', 'Latvian', 'lv'], ['mg', 'Malagasy', 'Malagasy', 'mg'], ['mi', 'Māori', 'Māori', 'nz'],
  ['mk', 'македонски', 'Macedonian', 'mk'], ['ml', 'മലയാളം', 'Malayalam', 'in'], ['mn', 'монгол', 'Mongolian', 'mn'],
  ['mr', 'मराठी', 'Marathi', 'in'], ['ms', 'Bahasa Melayu', 'Malay', 'my'], ['mt', 'Malti', 'Maltese', 'mt'],
  ['my', 'မြန်မာစာ', 'Burmese', 'mm'], ['ne', 'नेपाली', 'Nepali', 'np'], ['nl', 'Nederlands', 'Dutch', 'nl'],
  ['no', 'Norsk', 'Norwegian', 'no'], ['ny', 'Chichewa', 'Chichewa', 'mw'], ['or', 'ଓଡ଼ିଆ', 'Odia', 'in'],
  ['pa', 'ਪੰਜਾਬੀ', 'Punjabi', 'in'], ['pl', 'polski', 'Polish', 'pl'], ['ps', 'پښتو', 'Pashto', 'af'],
  ['pt', 'Português', 'Portuguese', 'pt'], ['ro', 'română', 'Romanian', 'ro'], ['ru', 'Русский', 'Russian', 'ru'],
  ['rw', 'Kinyarwanda', 'Kinyarwanda', 'rw'], ['sa', 'संस्कृतम्', 'Sanskrit', 'in'], ['si', 'සිංහල', 'Sinhala', 'lk'],
  ['sk', 'slovenčina', 'Slovak', 'sk'], ['sl', 'slovenščina', 'Slovenian', 'si'], ['so', 'Soomaaliga', 'Somali', 'so'],
  ['sq', 'shqip', 'Albanian', 'al'], ['sr', 'српски', 'Serbian', 'rs'], ['sv', 'svenska', 'Swedish', 'se'],
  ['sw', 'Kiswahili', 'Swahili', 'tz'], ['ta', 'தமிழ்', 'Tamil', 'in'], ['te', 'తెలుగు', 'Telugu', 'in'],
  ['tg', 'тоҷикӣ', 'Tajik', 'tj'], ['th', 'ไทย', 'Thai', 'th'], ['tk', 'Türkmençe', 'Turkmen', 'tm'],
  ['tl', 'Tagalog', 'Tagalog', 'ph'], ['tn', 'Setswana', 'Tswana', 'bw'], ['tr', 'Türkçe', 'Turkish', 'tr'],
  ['tt', 'татар теле', 'Tatar', 'ru'], ['uk', 'Українська', 'Ukrainian', 'ua'], ['ur', 'اردو', 'Urdu', 'pk'],
  ['uz', 'Oʻzbek', 'Uzbek', 'uz'], ['vi', 'Tiếng Việt', 'Vietnamese', 'vn'], ['xh', 'isiXhosa', 'Xhosa', 'za'],
  ['yi', 'ייִדיש', 'Yiddish', 'il'], ['yo', 'Yorùbá', 'Yoruba', 'ng'], ['zh', '中文', 'Chinese', 'cn'],
  ['zu', 'isiZulu', 'Zulu', 'za'], ['be', 'беларуская мова', 'Belarusian', 'by'], ['bo', 'བོད་ཡིག', 'Tibetan', 'cn'],
  ['br', 'brezhoneg', 'Breton', 'fr'], ['ee', 'Eʋegbe', 'Ewe', 'gh'], ['ff', 'Fulfulde', 'Fulah', 'sn'],
  ['ig', 'Igbo', 'Igbo', 'ng'], ['ku', 'Kurdî', 'Kurdish', 'iq'], ['lb', 'Lëtzebuergesch', 'Luxembourgish', 'lu'],
  ['ln', 'Lingála', 'Lingala', 'cd'], ['lu', 'Tshiluba', 'Luba-Katanga', 'cd'], ['nb', 'Norsk bokmål', 'Norwegian Bokmål', 'no'],
  ['om', 'Afaan Oromoo', 'Oromo', 'et'], ['qu', 'Runa Simi', 'Quechua', 'pe'], ['rm', 'rumantsch', 'Romansh', 'ch'],
  ['se', 'Davvisámegiella', 'Northern Sami', 'no'], ['st', 'Sesotho', 'Southern Sotho', 'ls'], ['ts', 'itsonga', 'Tsonga', 'za'],
  ['wo', 'Wolof', 'Wolof', 'sn'], ['za', 'Saɯ cueŋƅ', 'Zhuang', 'cn'],
].map(([code, native, english, flag]) => ({ code, native, english, flag }));

const ROUTES = {
  '/': { title: 'Dashboard', sub: 'Monitor gateway health, traffic, and recent activity.', copy: true },
  '/map': { title: 'Service map', sub: 'Live request path from client to upstream.', copy: false },
  '/providers': { title: 'Providers', sub: 'Every upstream this router can reach.', copy: false },
  '/proxy': { title: 'Proxy', sub: 'Route upstream traffic through a proxy pool.', copy: false },
  '/usage': { title: 'Usage', sub: 'Tokens and requests, broken down per model.', copy: false },
  '/chat': { title: 'Chat', sub: 'Talk to your local model gateway.', copy: false },
  '/combos': { title: 'Combos', sub: 'Virtual model names that fall back through a list.', copy: false },
  '/settings': { title: 'Settings', sub: 'Appearance and connection details.', copy: false },
  '/api-keys': { title: 'API Keys', sub: 'Manage access to your proxy endpoint.', copy: false },
};

