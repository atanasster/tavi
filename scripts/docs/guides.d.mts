export interface GuideImage {
  readonly src: string;
  readonly alt: string;
  readonly dark?: string;
}

export interface GuideStep {
  readonly number: number;
  readonly title: string;
  readonly key: string;
  readonly body: string;
  readonly images: readonly GuideImage[];
}

export interface Guide {
  readonly file: string;
  readonly folder: string;
  readonly slug: string;
  readonly title: string;
  readonly lead: string;
  readonly context: Readonly<Record<string, string>>;
  readonly steps: readonly GuideStep[];
  readonly sections: readonly string[];
  readonly cover?: GuideImage;
  readonly text: string;
}

export interface GuideFolder {
  readonly id: string;
  readonly title: string;
  readonly lead: string;
}

export const guidesRoot: string;
export const imagesRoot: string;
export const FOLDERS: readonly GuideFolder[];
export function stepKey(title: string): string;
export function readGuide(file: string): Guide;
export function listGuides(): Guide[];
export function stepImagePath(guide: Guide, step: GuideStep, extension: "webp" | "svg"): string;
export function indexes(guides?: readonly Guide[]): { readonly path: string; readonly text: string }[];
