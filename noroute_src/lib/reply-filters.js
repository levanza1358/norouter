import { getDb } from './db.js';

const MARKER = '[norouter reply style]';
const KEYS = {
  language: 'reply_filters.language',
  verbosity: 'reply_filters.verbosity',
  coding: 'reply_filters.coding',
};

// Common-language catalog. Flags are representative regions, not language ownership.
export const REPLY_LANGUAGES = [
  ['aa', 'Afar', 'Afar', '🇩🇯'], ['ab', 'аҧсшәа', 'Abkhazian', '🌐'], ['af', 'Afrikaans', 'Afrikaans', '🇿🇦'],
  ['ak', 'Akan', 'Akan', '🇬🇭'], ['am', 'አማርኛ', 'Amharic', '🇪🇹'], ['ar', 'العربية', 'Arabic', '🇸🇦'],
  ['as', 'অসমীয়া', 'Assamese', '🇮🇳'], ['av', 'авар мацӀ', 'Avaric', '🌐'], ['ay', 'Aymar aru', 'Aymara', '🇧🇴'],
  ['az', 'azərbaycan dili', 'Azerbaijani', '🇦🇿'], ['ba', 'башҡорт теле', 'Bashkir', '🌐'], ['be', 'беларуская мова', 'Belarusian', '🇧🇾'],
  ['bg', 'български език', 'Bulgarian', '🇧🇬'], ['bh', 'भोजपुरी', 'Bihari', '🇮🇳'], ['bm', 'bamanankan', 'Bambara', '🇲🇱'],
  ['bn', 'বাংলা', 'Bengali', '🇧🇩'], ['bo', 'བོད་ཡིག', 'Tibetan', '🇨🇳'], ['br', 'brezhoneg', 'Breton', '🇫🇷'],
  ['bs', 'bosanski jezik', 'Bosnian', '🇧🇦'], ['ca', 'català', 'Catalan', '🇪🇸'], ['ce', 'нохчийн мотт', 'Chechen', '🌐'],
  ['ch', 'Chamoru', 'Chamorro', '🇬🇺'], ['co', 'corsu', 'Corsican', '🇫🇷'], ['cr', 'ᓀᐦᐃᔭᐍᐏᐣ', 'Cree', '🌐'],
  ['cs', 'čeština', 'Czech', '🇨🇿'], ['cu', 'церковнославѧньскъ', 'Church Slavic', '🌐'], ['cv', 'чӑвашла', 'Chuvash', '🌐'],
  ['cy', 'Cymraeg', 'Welsh', '🏴'], ['da', 'dansk', 'Danish', '🇩🇰'], ['de', 'Deutsch', 'German', '🇩🇪'],
  ['dv', 'ދިވެހި', 'Divehi', '🇲🇻'], ['dz', 'རྫོང་ཁ', 'Dzongkha', '🇧🇹'], ['ee', 'Eʋegbe', 'Ewe', '🇬🇭'],
  ['el', 'Ελληνικά', 'Greek', '🇬🇷'], ['en', 'English', 'English', '🌐'], ['eo', 'Esperanto', 'Esperanto', '🌐'],
  ['es', 'Español', 'Spanish', '🇪🇸'], ['et', 'eesti', 'Estonian', '🇪🇪'], ['eu', 'euskara', 'Basque', '🇪🇸'],
  ['fa', 'فارسی', 'Persian', '🇮🇷'], ['ff', 'Fulfulde', 'Fulah', '🌐'], ['fi', 'suomi', 'Finnish', '🇫🇮'],
  ['fj', 'vosa Vakaviti', 'Fijian', '🇫🇯'], ['fo', 'føroyskt', 'Faroese', '🇫🇴'], ['fr', 'Français', 'French', '🇫🇷'],
  ['fy', 'Frysk', 'Western Frisian', '🇳🇱'], ['ga', 'Gaeilge', 'Irish', '🇮🇪'], ['gd', 'Gàidhlig', 'Scottish Gaelic', '🏴'],
  ['gl', 'galego', 'Galician', '🇪🇸'], ['gn', 'Avañe’ẽ', 'Guarani', '🇵🇾'], ['gu', 'ગુજરાતી', 'Gujarati', '🇮🇳'],
  ['gv', 'Gaelg', 'Manx', '🏴'], ['ha', 'Hausa', 'Hausa', '🇳🇬'], ['he', 'עברית', 'Hebrew', '🇮🇱'],
  ['hi', 'हिन्दी', 'Hindi', '🇮🇳'], ['ho', 'Hiri Motu', 'Hiri Motu', '🇵🇬'], ['hr', 'hrvatski', 'Croatian', '🇭🇷'],
  ['ht', 'Kreyòl ayisyen', 'Haitian Creole', '🇭🇹'], ['hu', 'magyar', 'Hungarian', '🇭🇺'], ['hy', 'հայերեն', 'Armenian', '🇦🇲'],
  ['hz', 'Otjiherero', 'Herero', '🇳🇦'], ['ia', 'Interlingua', 'Interlingua', '🌐'], ['id', 'Bahasa Indonesia', 'Indonesian', '🇮🇩'],
  ['ie', 'Interlingue', 'Interlingue', '🌐'], ['ig', 'Igbo', 'Igbo', '🇳🇬'], ['ii', 'ꆇꉙ', 'Sichuan Yi', '🇨🇳'],
  ['ik', 'Iñupiaq', 'Inupiaq', '🇺🇸'], ['io', 'Ido', 'Ido', '🌐'], ['is', 'íslenska', 'Icelandic', '🇮🇸'],
  ['it', 'Italiano', 'Italian', '🇮🇹'], ['iu', 'ᐃᓄᒃᑎᑐᑦ', 'Inuktitut', '🇨🇦'], ['ja', '日本語', 'Japanese', '🇯🇵'],
  ['jv', 'Basa Jawa', 'Javanese', '🇮🇩'], ['ka', 'ქართული', 'Georgian', '🇬🇪'], ['kg', 'Kikongo', 'Kongo', '🇨🇩'],
  ['ki', 'Gĩkũyũ', 'Kikuyu', '🇰🇪'], ['kj', 'Kuanyama', 'Kuanyama', '🇳🇦'], ['kk', 'қазақ тілі', 'Kazakh', '🇰🇿'],
  ['kl', 'kalaallisut', 'Kalaallisut', '🇬🇱'], ['km', 'ខ្មែរ', 'Khmer', '🇰🇭'], ['kn', 'ಕನ್ನಡ', 'Kannada', '🇮🇳'],
  ['ko', '한국어', 'Korean', '🇰🇷'], ['kr', 'Kanuri', 'Kanuri', '🌐'], ['ks', 'कश्मीरी', 'Kashmiri', '🇮🇳'],
  ['ku', 'Kurdî', 'Kurdish', '🌐'], ['kv', 'коми кыв', 'Komi', '🌐'], ['kw', 'Kernewek', 'Cornish', '🇬🇧'],
  ['ky', 'кыргызча', 'Kyrgyz', '🇰🇬'], ['la', 'latine', 'Latin', '🌐'], ['lb', 'Lëtzebuergesch', 'Luxembourgish', '🇱🇺'],
  ['lg', 'Luganda', 'Ganda', '🇺🇬'], ['li', 'Limburgs', 'Limburgish', '🇳🇱'], ['ln', 'Lingála', 'Lingala', '🇨🇩'],
  ['lo', 'ລາວ', 'Lao', '🇱🇦'], ['lt', 'lietuvių kalba', 'Lithuanian', '🇱🇹'], ['lu', 'Tshiluba', 'Luba-Katanga', '🇨🇩'],
  ['lv', 'latviešu valoda', 'Latvian', '🇱🇻'], ['mg', 'Malagasy', 'Malagasy', '🇲🇬'], ['mh', 'Kajin M̧ajeļ', 'Marshallese', '🇲🇭'],
  ['mi', 'Māori', 'Māori', '🇳🇿'], ['mk', 'македонски', 'Macedonian', '🇲🇰'], ['ml', 'മലയാളം', 'Malayalam', '🇮🇳'],
  ['mn', 'монгол', 'Mongolian', '🇲🇳'], ['mr', 'मराठी', 'Marathi', '🇮🇳'], ['ms', 'Bahasa Melayu', 'Malay', '🇲🇾'],
  ['mt', 'Malti', 'Maltese', '🇲🇹'], ['my', 'မြန်မာစာ', 'Burmese', '🇲🇲'], ['na', 'Dorerin Naoero', 'Nauru', '🇳🇷'],
  ['nb', 'Norsk bokmål', 'Norwegian Bokmål', '🇳🇴'], ['nd', 'isiNdebele', 'North Ndebele', '🇿🇼'], ['ne', 'नेपाली', 'Nepali', '🇳🇵'],
  ['ng', 'Owambo', 'Ndonga', '🇳🇦'], ['nl', 'Nederlands', 'Dutch', '🇳🇱'], ['nn', 'Norsk nynorsk', 'Norwegian Nynorsk', '🇳🇴'],
  ['no', 'Norsk', 'Norwegian', '🇳🇴'], ['nr', 'isiNdebele', 'South Ndebele', '🇿🇦'], ['nv', 'Diné bizaad', 'Navajo', '🇺🇸'],
  ['ny', 'Chichewa', 'Chichewa', '🇲🇼'], ['oc', 'occitan', 'Occitan', '🇫🇷'], ['oj', 'ᐧᐁᐧᐁᐧ', 'Ojibwa', '🇨🇦'],
  ['om', 'Afaan Oromoo', 'Oromo', '🇪🇹'], ['or', 'ଓଡ଼ିଆ', 'Odia', '🇮🇳'], ['os', 'ирон æвзаг', 'Ossetian', '🌐'],
  ['pa', 'ਪੰਜਾਬੀ', 'Punjabi', '🇮🇳'], ['pi', 'पालि', 'Pali', '🌐'], ['pl', 'polski', 'Polish', '🇵🇱'],
  ['ps', 'پښتو', 'Pashto', '🇦🇫'], ['pt', 'Português', 'Portuguese', '🇵🇹'], ['qu', 'Runa Simi', 'Quechua', '🇵🇪'],
  ['rm', 'rumantsch', 'Romansh', '🇨🇭'], ['rn', 'Ikirundi', 'Rundi', '🇧🇮'], ['ro', 'română', 'Romanian', '🇷🇴'],
  ['ru', 'Русский', 'Russian', '🇷🇺'], ['rw', 'Kinyarwanda', 'Kinyarwanda', '🇷🇼'], ['sa', 'संस्कृतम्', 'Sanskrit', '🇮🇳'],
  ['sc', 'sardu', 'Sardinian', '🇮🇹'], ['sd', 'سنڌي', 'Sindhi', '🇵🇰'], ['se', 'Davvisámegiella', 'Northern Sami', '🇳🇴'],
  ['sg', 'yângâ tî sängö', 'Sango', '🇨🇫'], ['si', 'සිංහල', 'Sinhala', '🇱🇰'], ['sk', 'slovenčina', 'Slovak', '🇸🇰'],
  ['sl', 'slovenščina', 'Slovenian', '🇸🇮'], ['sm', 'gagana Samoa', 'Samoan', '🇼🇸'], ['sn', 'chiShona', 'Shona', '🇿🇼'],
  ['so', 'Soomaaliga', 'Somali', '🇸🇴'], ['sq', 'shqip', 'Albanian', '🇦🇱'], ['sr', 'српски', 'Serbian', '🇷🇸'],
  ['ss', 'SiSwati', 'Swati', '🇸🇿'], ['st', 'Sesotho', 'Southern Sotho', '🇱🇸'], ['su', 'Basa Sunda', 'Sundanese', '🇮🇩'],
  ['sv', 'svenska', 'Swedish', '🇸🇪'], ['sw', 'Kiswahili', 'Swahili', '🇹🇿'], ['ta', 'தமிழ்', 'Tamil', '🇮🇳'],
  ['te', 'తెలుగు', 'Telugu', '🇮🇳'], ['tg', 'тоҷикӣ', 'Tajik', '🇹🇯'], ['th', 'ไทย', 'Thai', '🇹🇭'],
  ['ti', 'ትግርኛ', 'Tigrinya', '🇪🇷'], ['tk', 'Türkmençe', 'Turkmen', '🇹🇲'], ['tl', 'Tagalog', 'Tagalog', '🇵🇭'],
  ['tn', 'Setswana', 'Tswana', '🇧🇼'], ['to', 'faka Tonga', 'Tongan', '🇹🇴'], ['tr', 'Türkçe', 'Turkish', '🇹🇷'],
  ['ts', 'Xitsonga', 'Tsonga', '🇿🇦'], ['tt', 'татар теле', 'Tatar', '🌐'], ['tw', 'Twi', 'Twi', '🇬🇭'],
  ['ty', 'Reo Tahiti', 'Tahitian', '🇵🇫'], ['ug', 'ئۇيغۇرچە', 'Uyghur', '🇨🇳'], ['uk', 'Українська', 'Ukrainian', '🇺🇦'],
  ['ur', 'اردو', 'Urdu', '🇵🇰'], ['uz', 'Oʻzbek', 'Uzbek', '🇺🇿'], ['ve', 'Tshivenda', 'Venda', '🇿🇦'],
  ['vi', 'Tiếng Việt', 'Vietnamese', '🇻🇳'], ['vo', 'Volapük', 'Volapük', '🌐'], ['wa', 'walon', 'Walloon', '🇧🇪'],
  ['wo', 'Wolof', 'Wolof', '🇸🇳'], ['xh', 'isiXhosa', 'Xhosa', '🇿🇦'], ['yi', 'ייִדיש', 'Yiddish', '🌐'],
  ['yo', 'Yorùbá', 'Yoruba', '🇳🇬'], ['za', 'Saɯ cueŋƅ', 'Zhuang', '🇨🇳'], ['zh', '中文', 'Chinese', '🇨🇳'],
  ['zu', 'isiZulu', 'Zulu', '🇿🇦'],
].map(([code, native, english, flag]) => ({ code, native, english, flag }));

const LANGUAGE_CODES = new Set(['auto', 'none', ...REPLY_LANGUAGES.map((item) => item.code)]);
const VERBOSITIES = ['balanced', 'concise', 'detailed'];
const LANGUAGE_INSTRUCTIONS = {
  auto: `${MARKER} Reply in the same language as the user's most recent message.`,
};
const VERBOSITY_INSTRUCTIONS = {
  concise: `${MARKER} Answer directly and briefly; get to the point; skip boilerplate and filler.`,
  detailed: `${MARKER} Explain thoroughly; include reasoning and trade-offs.`,
};
const CODING_INSTRUCTION = `${MARKER} Prefer short, minimal code; no unnecessary comments or explanation unless the user asks.`;

function languageInstruction(code) {
  if (code === 'auto') return LANGUAGE_INSTRUCTIONS.auto;
  if (code === 'none') return '';
  const language = REPLY_LANGUAGES.find((item) => item.code === code);
  return language ? `${MARKER} Reply in ${language.native}.` : '';
}

function readValue(key, fallback) {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row == null ? fallback : row.value;
}

function readLanguage() {
  const value = readValue(KEYS.language, 'auto');
  return LANGUAGE_CODES.has(value) ? value : 'auto';
}

function readBoolean(key, fallback = false) {
  const value = readValue(key, '');
  return value === 'true' ? true : value === 'false' ? false : fallback;
}

export function getReplyFiltersSettings() {
  const verbosity = readValue(KEYS.verbosity, 'balanced');
  return {
    language: readLanguage(),
    verbosity: VERBOSITIES.includes(verbosity) ? verbosity : 'balanced',
    coding: readBoolean(KEYS.coding, false),
  };
}

export function setReplyFiltersSettings(patch = {}) {
  const current = getReplyFiltersSettings();
  const next = {
    language: patch.language ?? current.language,
    verbosity: patch.verbosity ?? current.verbosity,
    coding: patch.coding ?? current.coding,
  };
  for (const [field, key] of Object.entries(KEYS)) {
    getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(next[field]));
  }
  return next;
}

export function validateReplyFiltersPatch(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be an object.';
  const keys = Object.keys(body);
  const allowed = new Set(Object.keys(KEYS));
  if (keys.some((key) => !allowed.has(key))) return 'Only language, verbosity and coding settings are supported.';
  if (body.language !== undefined && !LANGUAGE_CODES.has(body.language)) return 'language must be a supported language code, auto, or none.';
  if (body.verbosity !== undefined && !VERBOSITIES.includes(body.verbosity)) return `verbosity must be one of: ${VERBOSITIES.join(', ')}.`;
  if (body.coding !== undefined && typeof body.coding !== 'boolean') return 'coding must be boolean.';
  return null;
}

export function buildInstruction(settings = {}) {
  const lines = [];
  const language = languageInstruction(settings.language);
  if (language) lines.push(language);
  const verbosity = VERBOSITY_INSTRUCTIONS[settings.verbosity];
  if (verbosity) lines.push(verbosity);
  if (settings.coding) lines.push(CODING_INSTRUCTION);
  return lines.join('\n');
}

function stripMarker(value) {
  return String(value || '').split('\n').filter((line) => !line.startsWith(MARKER)).join('\n').trim();
}

function addSystemInstruction(content, instruction) {
  if (typeof content === 'string') return [stripMarker(content), instruction].filter(Boolean).join('\n');
  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      if (part?.type !== 'text' || typeof part.text !== 'string') return part;
      return { ...part, text: stripMarker(part.text) };
    }).filter((part) => part?.type !== 'text' || part.text);
    return [...parts, { type: 'text', text: instruction }];
  }
  return instruction;
}

export function applyReplyFilters(body, settings = getReplyFiltersSettings()) {
  const instruction = buildInstruction(settings);
  if (!instruction || !Array.isArray(body?.messages)) return body;
  const messages = body.messages.map((message) => ({ ...message }));
  const existing = messages.find((message) => message?.role === 'system');
  if (existing) existing.content = addSystemInstruction(existing.content, instruction);
  else messages.unshift({ role: 'system', content: instruction });
  return { ...body, messages };
}

export { MARKER as REPLY_FILTERS_MARKER };
