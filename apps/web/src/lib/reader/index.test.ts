import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultPresentation,
  gestureStep,
  loadPresentation,
  loadProgress,
  move,
  savePresentation,
  saveProgress,
  setPresentation,
  visibleOrdinals,
  type ReaderDescriptor,
  type ReaderState,
} from './index';

const descriptor: ReaderDescriptor = {
  progressKey: 'opaque-source-key',
  revision: 'revision:2',
  validOrdinals: [2, 4, 8, 10],
  validPageCount: 4,
  nextPublicationId: null,
};

function state(mode = defaultPresentation.mode): ReaderState {
  return {
    descriptor,
    ordinal: 4,
    presentation: { ...defaultPresentation, mode },
    persistProgress: true,
  };
}

beforeEach(() => localStorage.clear());

describe('reader state', () => {
  it('navigates exclusively through valid ordinals', () => {
    expect(move(state(), 1).ordinal).toBe(8);
    expect(move({ ...state(), ordinal: 10 }, 1).ordinal).toBe(10);
    expect(move({ ...state(), ordinal: 3 }, 1).ordinal).toBe(3);
  });

  it('groups only validated adjacent ordinals in spread mode', () => {
    expect(visibleOrdinals(state('spread'))).toEqual([8, 4]);
    expect(move(state('spread'), 1).ordinal).toBe(10);
    expect(visibleOrdinals({ ...state('spread'), ordinal: 10 })).toEqual([10]);
  });

  it('keeps continuous modes in a bounded virtual ordinal window', () => {
    expect(visibleOrdinals(state('vertical'))).toEqual([2, 4, 8]);
    expect(visibleOrdinals({ ...state('webtoon'), ordinal: 10 })).toEqual([8, 10]);
  });

  it('clamps zoom and maps swipe direction', () => {
    expect(setPresentation(state(), { zoom: 20 }).presentation.zoom).toBe(3);
    expect(gestureStep(200, 20, 500, 'ltr')).toBe(1);
    expect(gestureStep(200, 20, 500, 'rtl')).toBe(1);
    expect(gestureStep(200, 190, 500, 'ltr')).toBeNull();
  });
});

describe('browser-local reader state', () => {
  it('validates versioned presentation and exact revision progress', () => {
    localStorage.setItem('gutter.reader.presentation.v1', '{"mode":"unknown","zoom":99}');
    expect(loadPresentation()).toEqual({ ...defaultPresentation, zoom: 3 });
    savePresentation({ ...defaultPresentation, mode: 'webtoon', zoom: 1.5 });
    expect(loadPresentation().mode).toBe('webtoon');

    saveProgress(descriptor, 8);
    expect(loadProgress(descriptor)).toBe(8);
    expect(loadProgress({ ...descriptor, revision: 'revision:3' })).toBeNull();
    expect(loadProgress({ ...descriptor, validOrdinals: [2, 4] })).toBeNull();
    saveProgress({ ...descriptor, progressKey: 'another-source' }, 4);
    expect(loadProgress(descriptor)).toBe(8);
  });
});
