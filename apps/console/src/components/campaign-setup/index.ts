/**
 * Presentation pieces for the campaign setup (docs/campaign-setup.md §2). No campaign or domain
 * knowledge lives here: the steps in `pages/campaigns/agency/setup/` feed them.
 */
export { StepCards, type StepCardItem, type StepCardsProps } from './StepCards';
export { ChoiceCardGroup, type ChoiceCardOption, type ChoiceCardGroupProps } from './ChoiceCardGroup';
export { PillGroup, type PillOption, type PillGroupProps } from './PillGroup';
export {
  SentenceSelect,
  Sentence,
  type SentenceSelectOption,
  type SentenceSelectProps,
  type SentenceProps,
} from './SentenceSelect';
export {
  SwitchRow,
  Switch,
  type SwitchRowProps,
  type SwitchProps,
  type SwitchRowControlIds,
} from './SwitchRow';
export {
  StatusChip,
  StatusChipRow,
  type StatusChipProps,
  type StatusChipRowProps,
  type StatusChipTone,
} from './StatusChip';
export { AdvancedFold, type AdvancedFoldProps } from './AdvancedFold';
export {
  SetupCard,
  SetupSection,
  SetupColumns,
  type SetupCardProps,
  type SetupSectionProps,
  type SetupColumnsProps,
} from './SetupCard';
