import {
  Ban,
  BookOpen,
  CircleCheck,
  CircleDot,
  Clock,
  Coffee,
  Droplet,
  Headphones,
  IndianRupee,
  LogOut,
  MicOff,
  MonitorSmartphone,
  Pause,
  Phone,
  PhoneIncoming,
  PhoneOff,
  ThumbsDown,
  ThumbsUp,
  TriangleAlert,
  Users,
  UtensilsCrossed,
  VolumeX,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { BandIcon } from '../../../utils/agency/stationView';
import type { BreakIcon, OutcomeIcon } from '../../../utils/agency/stationTiles';

/** Every station picture is a lucide icon, `aria-hidden`: the words beside it carry the meaning. */
export const BAND_ICONS: Record<BandIcon, LucideIcon> = {
  headphones: Headphones,
  mic_off: MicOff,
  wifi_off: WifiOff,
  phone_in: PhoneIncoming,
  phone: Phone,
  check: CircleCheck,
  cup: Coffee,
  warning: TriangleAlert,
  pause: Pause,
  device: MonitorSmartphone,
  log_out: LogOut,
};

export const OUTCOME_ICON_COMPONENTS: Record<OutcomeIcon, LucideIcon> = {
  rupee: IndianRupee,
  clock: Clock,
  stop: Ban,
  thumbs_up: ThumbsUp,
  no_voice: VolumeX,
  refused: ThumbsDown,
  wrong_number: PhoneOff,
  dot: CircleDot,
};

export const BREAK_ICON_COMPONENTS: Record<BreakIcon, LucideIcon> = {
  cup: Coffee,
  meal: UtensilsCrossed,
  washroom: Droplet,
  meeting: Users,
  training: BookOpen,
  phone: Phone,
  pause: Pause,
};
