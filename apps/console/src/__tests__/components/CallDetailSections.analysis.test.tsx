import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { CallAnalysisResult } from '../../types/call';

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  retryAnalysis: vi.fn(),
  loadTranscriptVisible: vi.fn(),
  saveTranscriptVisible: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/calls', () => ({ retryAnalysis: mocks.retryAnalysis, fetchRecordingBlobUrl: vi.fn() }));
vi.mock('../../utils/transcript-prefs', () => ({
  loadTranscriptVisible: mocks.loadTranscriptVisible,
  saveTranscriptVisible: mocks.saveTranscriptVisible,
}));
vi.mock('../../components/audio/AudioWaveform', () => ({ AudioWaveform: () => <div data-testid="waveform" /> }));

import { AnalysisSection, AnalysisStatusCard, TranscriptSection } from '../../components/calls/CallDetailSections';

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.loadTranscriptVisible.mockReturnValue(true);
  mocks.retryAnalysis.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AnalysisStatusCard — generalized retry seam', () => {
  it('announces the compact pending state', () => {
    render(<AnalysisStatusCard status="pending" callId="call-1" onRetryComplete={vi.fn()} />);

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-atomic')).toBe('true');
    expect(status.textContent).toContain('Analysis is in progress...');
    expect(screen.queryByLabelText('Loading')).toBeNull();
  });

  it('calls custom onRetry rather than the default AI-call endpoint, then completes', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const onRetryComplete = vi.fn();
    render(<AnalysisStatusCard status="failed" callId="call-1" onRetry={onRetry} onRetryComplete={onRetryComplete} />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry Analysis' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    expect(mocks.retryAnalysis).not.toHaveBeenCalled();
    expect(onRetryComplete).toHaveBeenCalledTimes(1);
  });

  it('preserves the default AI-call retry behaviour when onRetry is omitted', async () => {
    const onRetryComplete = vi.fn();
    render(<AnalysisStatusCard status="failed" callId="call-1" onRetryComplete={onRetryComplete} />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry Analysis' }));
    await waitFor(() => expect(mocks.retryAnalysis).toHaveBeenCalledWith('tenant-1', 'call-1', 'account-1'));
    expect(onRetryComplete).toHaveBeenCalledTimes(1);
  });

  it('honours custom title, per-status copy, retry label and a false retry guard', () => {
    render(
      <AnalysisStatusCard
        status="failed"
        callId="call-1"
        onRetryComplete={vi.fn()}
        title="Call summary"
        messages={{ failed: 'Custom failure text' }}
        retryLabel="Try again"
        canRetry={false}
      />,
    );

    expect(screen.getByText('Call summary')).toBeTruthy();
    expect(screen.getByText('Custom failure text')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it.each([
    ['awaiting_recording', "We're waiting for the phone provider to deliver the recording. This usually takes a few minutes."],
    ['expired', "The phone provider never delivered a recording, so we couldn't create a summary."],
  ])('renders dialer vocabulary for %s', (status, copy) => {
    render(<AnalysisStatusCard status={status} callId="call-1" onRetryComplete={vi.fn()} canRetry={status === 'expired'} />);
    expect(screen.getByText(copy)).toBeTruthy();
  });
});

describe('TranscriptSection — dialer role and sentiment variations', () => {
  const entries = [
    { role: 'agent', content: 'Hello there', language: 'en' },
    { role: 'customer', content: 'I need help' },
  ];

  it('uses explicit agent/customer labels and applies the corresponding turn sentiment', () => {
    render(
      <TranscriptSection
        entries={entries}
        roleLabels={{ agent: 'Agent', customer: 'Customer' }}
        turnSentiments={[{ turn_index: 1, role: 'customer', sentiment: { label: 'negative', score: -0.7 } }]}
      />,
    );

    expect(screen.getByText('Agent')).toBeTruthy();
    expect(screen.getByText('Customer')).toBeTruthy();
    expect(screen.getByText('negative')).toBeTruthy();
    expect(screen.getByText('negative').getAttribute('title')).toBe('Sentiment: negative (-0.7)');
  });

  it('renders role-labelled input without role chips when labels are deliberately omitted', () => {
    render(<TranscriptSection entries={entries} roleLabels={{}} />);

    expect(screen.getByText('Hello there')).toBeTruthy();
    expect(screen.getByText('I need help')).toBeTruthy();
    expect(screen.queryByText('Agent')).toBeNull();
    expect(screen.queryByText('Customer')).toBeNull();
    expect(screen.queryByText('Unknown')).toBeNull();
  });

  it('preserves default AI-call rendering when no new props are supplied', () => {
    render(<TranscriptSection entries={[{ role: 'assistant', content: 'AI reply' }, { role: 'user', content: 'Caller reply' }]} />);

    expect(screen.getByText('assistant')).toBeTruthy();
    expect(screen.getByText('user')).toBeTruthy();
    expect(screen.getByText('AI reply')).toBeTruthy();
  });

  it('ignores a post-truncation sentiment index that cannot resolve to a displayed turn', () => {
    render(
      <TranscriptSection
        entries={entries}
        roleLabels={{ agent: 'Agent', customer: 'Customer' }}
        turnSentiments={[{ turn_index: 99, role: 'customer', sentiment: { label: 'positive', score: 1 } }]}
      />,
    );

    expect(screen.getByText('Hello there')).toBeTruthy();
    expect(screen.queryByText('positive')).toBeNull();
  });
});

describe('AnalysisSection — nested and legacy compatibility', () => {
  it('renders a nested common/custom analysis payload', () => {
    const analysis = {
      common: {
        summary: 'Nested summary',
        overall_sentiment: { label: 'positive', score: 0.8 },
        key_topics: ['payment plan'],
        conversation_quality: { resolution: true },
      },
      custom: { payment_agreed: true },
    } as unknown as CallAnalysisResult;
    render(<AnalysisSection analysis={analysis} />);

    expect(screen.getByText('Nested summary')).toBeTruthy();
    expect(screen.getByText('payment plan')).toBeTruthy();
    expect(screen.getByText('payment agreed')).toBeTruthy();
    expect(screen.getByText('true')).toBeTruthy();
  });

  it('preserves legacy flat analysis rendering and accepts absent/empty custom dimensions', () => {
    const analysis = {
      summary: 'Legacy summary',
      overall_sentiment: { label: 'neutral', score: 0 },
      key_topics: ['legacy topic'],
      conversation_quality: {},
      custom_dimensions: {},
    } as unknown as CallAnalysisResult;
    render(<AnalysisSection analysis={analysis} />);

    expect(screen.getByText('Legacy summary')).toBeTruthy();
    expect(screen.getByText('legacy topic')).toBeTruthy();
    expect(screen.queryByText('Custom Dimensions')).toBeNull();
  });

  it('does not render a custom-dimensions block when custom values are missing', () => {
    render(<AnalysisSection analysis={{ common: { summary: 'No custom values' } } as unknown as CallAnalysisResult} />);
    expect(screen.getByText('No custom values')).toBeTruthy();
    expect(screen.queryByText('Custom Dimensions')).toBeNull();
  });
});
