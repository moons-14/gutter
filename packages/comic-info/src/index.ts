import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';

export const comicInfoRuleSet = 'comicinfo-anansi-v2.1-draft-compatible-v1';
export const maxComicInfoBytes = 1024 * 1024;
export const maxComicInfoWarnings = 100;
export const maxComicInfoNodes = 4096;
export const maxComicInfoDepth = 32;
export const maxComicInfoListValues = 256;
export const maxComicInfoScalarChars = 64 * 1024;
export const maxComicInfoLongTextChars = 64 * 1024;
export const maxComicInfoIssueDetailChars = 256;

export type ComicInfoIssue = Readonly<{
  code: string;
  rule: string;
  detail?: string;
}>;
export type ComicInfoPageAnnotation = Readonly<{
  image: number;
  type?: string;
  doublePage?: boolean;
  imageSize?: number;
  key?: string;
  bookmark?: string;
  imageWidth?: number;
  imageHeight?: number;
}>;
export type ComicInfoDocument = Readonly<{
  fields: Readonly<Record<string, string | number | readonly string[]>>;
  pageAnnotations: readonly ComicInfoPageAnnotation[];
  claimedPageCount: number | null;
  sha256: string;
}>;
export type ComicInfoParseResult = Readonly<{
  document: ComicInfoDocument | null;
  issues: readonly ComicInfoIssue[];
}>;

const stringFields: Readonly<Record<string, string>> = {
  Title: 'title',
  Series: 'series',
  Number: 'number',
  AlternateSeries: 'alternateSeries',
  AlternateNumber: 'alternateNumber',
  Summary: 'summary',
  Notes: 'notes',
  Writer: 'writers',
  Penciller: 'pencillers',
  Inker: 'inkers',
  Colorist: 'colorists',
  Letterer: 'letterers',
  CoverArtist: 'coverArtists',
  Editor: 'editors',
  Publisher: 'publisher',
  Imprint: 'imprint',
  Genre: 'genres',
  Web: 'web',
  LanguageISO: 'languageIso',
  Format: 'format',
  Characters: 'characters',
  Teams: 'teams',
  Locations: 'locations',
  ScanInformation: 'scanInformation',
  StoryArc: 'storyArc',
  SeriesGroup: 'seriesGroup',
  MainCharacterOrTeam: 'mainCharacterOrTeam',
  Review: 'review',
};
const listElements = new Set([
  'Writer',
  'Penciller',
  'Inker',
  'Colorist',
  'Letterer',
  'CoverArtist',
  'Editor',
  'Genre',
  'Characters',
  'Teams',
  'Locations',
]);
const integerFields: Readonly<Record<string, string>> = {
  Count: 'count',
  Volume: 'volume',
  AlternateCount: 'alternateCount',
  Year: 'year',
  Month: 'month',
  Day: 'day',
  PageCount: 'pageCount',
};
const enumFields: Readonly<Record<string, readonly string[]>> = {
  BlackAndWhite: ['Unknown', 'No', 'Yes'],
  Manga: ['Unknown', 'No', 'Yes', 'YesAndRightToLeft'],
  AgeRating: [
    'Unknown',
    'Adults Only 18+',
    'Early Childhood',
    'Everyone',
    'Everyone 10+',
    'G',
    'Kids to Adults',
    'M',
    'MA15+',
    'Mature 17+',
    'PG',
    'R18+',
    'Rating Pending',
    'Teen',
    'X18+',
  ],
};
const pageTypes = new Set([
  'FrontCover',
  'InnerCover',
  'Roundup',
  'Story',
  'Advertisement',
  'Editorial',
  'Letters',
  'Preview',
  'BackCover',
  'Other',
  'Deleted',
]);
const longScalarFields = new Set(['Summary', 'Notes', 'Review']);

function parseInteger(value: string): number | null {
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}
function issue(issues: ComicInfoIssue[], code: string, detail?: string): void {
  const normalized = detail?.trim().slice(0, maxComicInfoIssueDetailChars);
  if (issues.some((entry) => entry.code === code && entry.detail === normalized)) return;
  if (issues.length < maxComicInfoWarnings)
    issues.push({ code, rule: comicInfoRuleSet, ...(normalized ? { detail: normalized } : {}) });
}
function textValue(value: string, element: string, issues: ComicInfoIssue[]): string | null {
  const trimmed = value.trim();
  const limit = longScalarFields.has(element) ? maxComicInfoLongTextChars : maxComicInfoScalarChars;
  if (trimmed.length > limit) {
    issue(issues, 'text_too_long', element);
    return null;
  }
  if (!trimmed) {
    issue(issues, 'empty_value', element);
    return null;
  }
  return trimmed;
}

function listValue(value: string, element: string, issues: ComicInfoIssue[]): readonly string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      issue(issues, 'list_empty_value', element);
      continue;
    }
    if (seen.has(trimmed)) {
      issue(issues, 'list_duplicate_value', element);
      continue;
    }
    if (values.length >= maxComicInfoListValues) {
      issue(issues, 'list_value_limit', element);
      continue;
    }
    seen.add(trimmed);
    values.push(trimmed);
  }
  return values;
}

/** Parses only a deliberately small, local ComicInfo projection; it never resolves external entities. */
export function parseComicInfo(bytes: Uint8Array): ComicInfoParseResult {
  const issues: ComicInfoIssue[] = [];
  if (bytes.byteLength > maxComicInfoBytes) {
    issue(issues, 'document_too_large');
    return { document: null, issues };
  }
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    issue(issues, 'invalid_utf8');
    return { document: null, issues };
  }
  const declaration = xml.match(/^\s*<\?xml\s+[^>]*encoding\s*=\s*(['"])(.*?)\1/i);
  if (declaration && declaration[2]?.toLowerCase() !== 'utf-8') {
    issue(issues, 'non_utf8_encoding');
    return { document: null, issues };
  }
  const version = xml.match(/^\s*<\?xml\s+[^>]*version\s*=\s*(['"])(.*?)\1/i);
  if (version && version[2] !== '1.0') {
    issue(issues, 'non_xml_1_0');
    return { document: null, issues };
  }
  let fatal = false;
  let depth = 0;
  let nodes = 0;
  let rootSeen = false;
  let rootClosed = false;
  const stack: Array<{ name: string; text: string }> = [];
  const fields: Record<string, string | number | readonly string[]> = {};
  const annotations: ComicInfoPageAnnotation[] = [];
  const parser = new SaxesParser({ xmlns: true });
  const fail = (code: string, detail?: string) => {
    if (!fatal) issue(issues, code, detail);
    fatal = true;
  };
  parser.on('error', () => fail('malformed_xml'));
  parser.on('doctype', () => fail('doctype_or_entity_rejected'));
  parser.on('opentag', (tag) => {
    nodes += 1;
    depth += 1;
    if (depth > maxComicInfoDepth || nodes > maxComicInfoNodes) fail('document_complexity_limit');
    if (tag.prefix || tag.uri) fail('namespace_rejected');
    for (const attribute of Object.values(tag.attributes))
      if (
        typeof attribute !== 'string' &&
        (attribute.prefix || attribute.uri || attribute.name.startsWith('xmlns'))
      )
        fail('namespace_rejected');
    if (!rootSeen) {
      rootSeen = true;
      if (tag.name !== 'ComicInfo') fail('invalid_root', tag.name);
    } else if (rootClosed) fail('multiple_roots');
    stack.push({ name: tag.name, text: '' });
    if (tag.name === 'Page' && stack.length === 3 && stack[1]?.name === 'Pages') {
      const attrs = tag.attributes as Record<string, { value: string } | string>;
      const value = (name: string) =>
        typeof attrs[name] === 'string' ? attrs[name] : attrs[name]?.value;
      const image = parseInteger(value('Image') ?? '');
      const knownAttributes = new Set([
        'Image',
        'Type',
        'DoublePage',
        'ImageSize',
        'Key',
        'Bookmark',
        'ImageWidth',
        'ImageHeight',
      ]);
      for (const attribute of Object.keys(attrs))
        if (!knownAttributes.has(attribute)) issue(issues, 'unknown_attribute');
      if (image === null) {
        issue(issues, 'page_missing_or_invalid_image');
        return;
      }
      const annotation: {
        image: number;
        type?: string;
        doublePage?: boolean;
        imageSize?: number;
        key?: string;
        bookmark?: string;
        imageWidth?: number;
        imageHeight?: number;
      } = { image };
      const type = value('Type');
      if (type === '') issue(issues, 'page_empty_type');
      else if (type) {
        if (type.includes(',') || !pageTypes.has(type)) issue(issues, 'page_invalid_type', type);
        else annotation.type = type;
      }
      const doublePage = value('DoublePage');
      if (doublePage === '') issue(issues, 'page_empty_double_page');
      else if (doublePage) {
        if (doublePage === 'true' || doublePage === '1') annotation.doublePage = true;
        else if (doublePage === 'false' || doublePage === '0') annotation.doublePage = false;
        else issue(issues, 'page_invalid_double_page');
      }
      for (const [attribute, key] of [
        ['ImageSize', 'imageSize'],
        ['ImageWidth', 'imageWidth'],
        ['ImageHeight', 'imageHeight'],
      ] as const) {
        const numeric = value(attribute);
        if (numeric !== undefined) {
          const parsed = parseInteger(numeric);
          if (parsed === null) issue(issues, 'page_invalid_integer', attribute);
          else annotation[key] = parsed;
        }
      }
      for (const [attribute, key] of [
        ['Key', 'key'],
        ['Bookmark', 'bookmark'],
      ] as const) {
        const raw = value(attribute);
        if (raw !== undefined) {
          const parsed = textValue(raw, attribute, issues);
          if (parsed !== null) annotation[key] = parsed;
        }
      }
      if (annotations.some((candidate) => candidate.image === image))
        issue(issues, 'page_duplicate_image');
      else annotations.push(annotation);
    } else if (
      stack.length === 2 &&
      tag.name !== 'Pages' &&
      !stringFields[tag.name] &&
      !integerFields[tag.name] &&
      !enumFields[tag.name] &&
      tag.name !== 'CommunityRating'
    )
      issue(issues, 'unknown_element', tag.name);
  });
  parser.on('text', (text) => {
    const current = stack.at(-1);
    if (current) current.text += text;
  });
  parser.on('cdata', (text) => {
    const current = stack.at(-1);
    if (current) current.text += text;
  });
  parser.on('closetag', (tag) => {
    const current = stack.pop();
    depth -= 1;
    if (!current || current.name !== tag.name) {
      fail('malformed_xml');
      return;
    }
    if (depth === 0) rootClosed = true;
    if (stack.length !== 1 || current.name === 'Page') return;
    const value = textValue(current.text, current.name, issues);
    if (value === null) return;
    const key =
      stringFields[current.name] ??
      integerFields[current.name] ??
      (current.name === 'CommunityRating'
        ? 'communityRating'
        : enumFields[current.name]
          ? current.name[0].toLowerCase() + current.name.slice(1)
          : undefined);
    if (key && Object.hasOwn(fields, key)) {
      fail('duplicate_field', current.name);
      return;
    }
    if (stringFields[current.name]) {
      const stringKey = stringFields[current.name];
      fields[stringKey] = listElements.has(current.name)
        ? listValue(value, current.name, issues)
        : value;
    } else if (integerFields[current.name]) {
      const parsed = parseInteger(value);
      if (
        parsed === null ||
        (current.name === 'Month' && (parsed < 1 || parsed > 12)) ||
        (current.name === 'Day' && (parsed < 1 || parsed > 31))
      )
        issue(issues, 'invalid_integer', current.name);
      else fields[integerFields[current.name]] = parsed;
    } else if (current.name === 'CommunityRating') {
      const parsed = Number(value);
      if (!/^(?:[0-5])(?:\.\d{1,2})?$/.test(value) || !Number.isFinite(parsed) || parsed > 5)
        issue(issues, 'invalid_community_rating');
      else fields.communityRating = parsed;
    } else if (enumFields[current.name]) {
      if (!enumFields[current.name].includes(value)) issue(issues, 'invalid_enum', current.name);
      else fields[current.name[0].toLowerCase() + current.name.slice(1)] = value;
    }
  });
  try {
    parser.write(xml).close();
  } catch {
    fail('malformed_xml');
  }
  if (!rootSeen || !rootClosed) fail('malformed_xml');
  if (fatal) return { document: null, issues };
  return {
    document: {
      fields,
      pageAnnotations: annotations,
      claimedPageCount: typeof fields.pageCount === 'number' ? fields.pageCount : null,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    issues,
  };
}
