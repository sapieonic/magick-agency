import {
  Ban,
  CalendarDays,
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleX,
  Clock,
  Coffee,
  Flower2,
  Footprints,
  GraduationCap,
  Headset,
  IndianRupee,
  Languages,
  PersonStanding,
  PhoneCall,
  PhoneMissed,
  PhoneOff,
  ThumbsDown,
  ThumbsUp,
  Toilet,
  Users,
  UtensilsCrossed,
  Voicemail,
  type LucideIcon,
} from 'lucide-react';

/**
 * The pictures of the agent station's tiles (agent station BE-13): one lucide icon, and a name in
 * plain words, for each key of the contract's `AGENCY_TILE_ICONS` (`packages/contracts/src/agency/
 * tile-icons.ts`). An outcome or a break reason may name one (`icon`); the campaign Settings picker
 * offers them and the console's station draws them, from this one map, so the supervisor picks
 * exactly the picture agents see. The mobile app draws its own from the same keys.
 *
 * This package does not import the contracts, so the keys are repeated here; the console's
 * `apps/console/src/__tests__/components/TileIconPicker.test.tsx` fails when this list and
 * `AGENCY_TILE_ICONS` differ.
 */
export const TILE_ICON_KEYS = [
  'rupee',
  'clock',
  'calendar',
  'stop',
  'thumbs_up',
  'thumbs_down',
  'check',
  'cross',
  'phone_missed',
  'phone_busy',
  'voicemail',
  'wrong_number',
  'language',
  'question',
  'tea',
  'lunch',
  'washroom',
  'meeting',
  'training',
  'prayer',
  'headset',
  'walk',
  'person',
  'dot',
] as const;

export type TileIconKey = (typeof TILE_ICON_KEYS)[number];

export const TILE_ICONS: Readonly<Record<TileIconKey, LucideIcon>> = {
  rupee: IndianRupee,
  clock: Clock,
  calendar: CalendarDays,
  stop: Ban,
  thumbs_up: ThumbsUp,
  thumbs_down: ThumbsDown,
  check: CircleCheck,
  cross: CircleX,
  phone_missed: PhoneMissed,
  phone_busy: PhoneCall,
  voicemail: Voicemail,
  wrong_number: PhoneOff,
  language: Languages,
  question: CircleHelp,
  tea: Coffee,
  lunch: UtensilsCrossed,
  washroom: Toilet,
  meeting: Users,
  training: GraduationCap,
  prayer: Flower2,
  headset: Headset,
  walk: Footprints,
  person: PersonStanding,
  dot: CircleDot,
};

/** Each picture's name, for a picker's label and a screen reader (simple Indian English, AS15). */
export const TILE_ICON_LABELS: Readonly<Record<TileIconKey, string>> = {
  rupee: 'Rupee',
  clock: 'Clock',
  calendar: 'Calendar',
  stop: 'Stop',
  thumbs_up: 'Thumbs up',
  thumbs_down: 'Thumbs down',
  check: 'Tick',
  cross: 'Cross',
  phone_missed: 'Missed call',
  phone_busy: 'Line busy',
  voicemail: 'Voicemail',
  wrong_number: 'Wrong number',
  language: 'Language',
  question: 'Question',
  tea: 'Tea',
  lunch: 'Lunch',
  washroom: 'Washroom',
  meeting: 'Meeting',
  training: 'Training',
  prayer: 'Prayer',
  headset: 'Headset',
  walk: 'Walk',
  person: 'Person',
  dot: 'Dot',
};

/** Whether `value` is one of the pictures (a stray stored value is not: draw none for it). */
export function isTileIconKey(value: unknown): value is TileIconKey {
  return typeof value === 'string' && (TILE_ICON_KEYS as readonly string[]).includes(value);
}

/**
 * One tile picture, decorative (`aria-hidden`): the words beside it carry the meaning. Renders
 * nothing for a key it does not know.
 */
export function TileIcon({ icon, size = 18, className }: { icon: string | null | undefined; size?: number; className?: string }) {
  if (!isTileIconKey(icon)) return null;
  const Icon = TILE_ICONS[icon];
  return <Icon size={size} className={className} aria-hidden="true" data-tile-icon={icon} />;
}
