/**
 * Tests for RequestProductActionDialog component
 *
 * Focused on the initial-request-type behavior. The dialog uses Radix Select
 * elements which hang in jsdom when interacted with, so these tests only assert
 * static text rendered by the dialog header — which is driven directly by the
 * initial request-type state.
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '@/test/utils';
import RequestProductActionDialog from './request-product-action-dialog';

// Mock hooks that hit external services. ``mockGet``/``mockPost`` are mutated
// per test so we can drive the wizard-launch branch deterministically.
const mockGet = vi.fn();
const mockPost = vi.fn();
const mockLookupWorkflowId = vi.fn();

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() })
}));

vi.mock('@/hooks/use-api', () => ({
  useApi: () => ({
    get: mockGet,
    post: mockPost,
  })
}));

vi.mock('@/hooks/use-approval-wizard-trigger', async () => {
  // Re-export the type-only ``AppActionTriggerType`` from the real module so
  // this mock stays in sync if the union changes upstream.
  const actual = await vi.importActual<typeof import('@/hooks/use-approval-wizard-trigger')>(
    '@/hooks/use-approval-wizard-trigger',
  );
  return {
    ...actual,
    useApprovalWizardTrigger: () => ({ lookupWorkflowId: mockLookupWorkflowId }),
  };
});

// ApprovalWizardDialog is mocked to a controllable harness so we can synthesize
// onComplete with arbitrary wizardFields without driving the real wizard.
vi.mock('@/components/workflows/approval-wizard-dialog', () => {
  return {
    default: ({ isOpen, preselectedWorkflowId, onComplete }: any) =>
      isOpen ? (
        <div data-testid="wizard-mock" data-workflow-id={preselectedWorkflowId}>
          <button
            data-testid="wizard-complete-btn"
            onClick={() =>
              onComplete?.('agr-123', null, { custom_field: 'foo', urgency: 'high' })
            }
          >
            Complete
          </button>
        </div>
      ) : null,
  };
});

vi.mock('@/stores/notifications-store', () => ({
  useNotificationsStore: (selector: any) =>
    selector({ refreshNotifications: vi.fn() })
}));

describe('RequestProductActionDialog default request type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: [] });
    mockPost.mockResolvedValue({ data: { id: 'req-1' } });
    mockLookupWorkflowId.mockResolvedValue(null);
  });

  it("defaults to 'access' when defaultRequestType is not provided", () => {
    renderWithProviders(
      <RequestProductActionDialog
        isOpen={true}
        onOpenChange={vi.fn()}
        productId="prod-1"
        productName="Test Product"
        productStatus="draft"
      />
    );

    // Header title is driven by the active request type. 'access' renders
    // 'Request Access to Product'; 'status_change' would render
    // 'Request Status Change' / 'Change Status'.
    expect(
      screen.getByRole('heading', { name: /Request Access to Product/ })
    ).toBeInTheDocument();
  });

  it("uses 'status_change' when defaultRequestType='status_change' is passed", () => {
    renderWithProviders(
      <RequestProductActionDialog
        isOpen={true}
        onOpenChange={vi.fn()}
        productId="prod-1"
        productName="Test Product"
        productStatus="draft"
        defaultRequestType="status_change"
      />
    );

    // The dialog title (h2) reflects the active request type. Scope the
    // assertion to the heading role so we don't match identical text in the
    // request-type Select dropdown options.
    expect(
      screen.getByRole('heading', { name: /Request Status Change/ })
    ).toBeInTheDocument();
  });

  it("uses 'status_change' direct-change title when canDirectStatusChange is true", () => {
    renderWithProviders(
      <RequestProductActionDialog
        isOpen={true}
        onOpenChange={vi.fn()}
        productId="prod-1"
        productName="Test Product"
        productStatus="draft"
        defaultRequestType="status_change"
        canDirectStatusChange={true}
      />
    );

    // With direct-change permission the title flips to 'Change Status'.
    expect(
      screen.getByRole('heading', { name: /Change Status/ })
    ).toBeInTheDocument();
  });
});

/**
 * Path-B portable wizard launch — when a ``for_request_*`` workflow is
 * configured for the chosen request type, Submit must open the wizard before
 * the original API call fires; on wizard completion the collected fields are
 * merged into the submit body. When no workflow is configured, Submit falls
 * through to today's direct-submit behavior.
 */
describe('RequestProductActionDialog approval-wizard launch (Path B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: [] });
    mockPost.mockResolvedValue({ data: { id: 'req-1' } });
  });

  it('falls through to direct submit when no for_request_access workflow is configured', async () => {
    mockLookupWorkflowId.mockResolvedValue(null);

    renderWithProviders(
      <RequestProductActionDialog
        isOpen={true}
        onOpenChange={vi.fn()}
        productId="prod-1"
        productName="Test Product"
        productStatus="active"
      />,
    );

    // Fill in a valid reason (>=10 chars) and submit.
    // The reason field uses i18n keys for the label which may resolve to the
    // raw key in tests; locate by the stable element id used in the source.
    const reasonField = document.getElementById('access-message') as HTMLTextAreaElement;
    expect(reasonField).not.toBeNull();
    fireEvent.change(reasonField, { target: { value: 'Need access for the Q3 analytics rollup.' } });
    fireEvent.click(screen.getByRole('button', { name: /Send Request/i }));

    await waitFor(() => {
      expect(mockLookupWorkflowId).toHaveBeenCalledWith('for_request_access');
    });
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledTimes(1);
    });
    // Direct submit — no wizard rendered, no wizard_data on the body.
    expect(screen.queryByTestId('wizard-mock')).toBeNull();
    const [endpoint, body] = mockPost.mock.calls[0];
    expect(endpoint).toBe('/api/access-grants/request');
    expect((body as Record<string, unknown>).wizard_data).toBeUndefined();
  });

  it('launches the wizard when a for_request_access workflow is configured, then submits with merged wizard fields', async () => {
    mockLookupWorkflowId.mockResolvedValue('wf-portable-1');

    renderWithProviders(
      <RequestProductActionDialog
        isOpen={true}
        onOpenChange={vi.fn()}
        productId="prod-1"
        productName="Test Product"
        productStatus="active"
      />,
    );

    // Lookup runs at dialog-open time — wait for it to resolve before
    // asserting the wizard-configured branch took effect.
    await waitFor(() => {
      expect(mockLookupWorkflowId).toHaveBeenCalledWith('for_request_access');
    });

    // Form fields must NOT be rendered when wizard is configured (this is the
    // duplicate-prompt fix — wizard owns user input).
    await waitFor(() => {
      expect(document.getElementById('access-message')).toBeNull();
    });
    // Submit button label flips to "Continue" to set the right expectation.
    const continueBtn = await screen.findByRole('button', { name: /Continue/i });
    fireEvent.click(continueBtn);

    // Wizard mock should appear with the configured workflow id.
    await waitFor(() => {
      expect(screen.getByTestId('wizard-mock')).toBeInTheDocument();
    });
    expect(screen.getByTestId('wizard-mock').getAttribute('data-workflow-id')).toBe('wf-portable-1');
    // Critical: API submit must NOT have happened yet.
    expect(mockPost).not.toHaveBeenCalled();

    // Drive wizard onComplete — synthesizes wizardFields = {custom_field, urgency}.
    fireEvent.click(screen.getByTestId('wizard-complete-btn'));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledTimes(1);
    });
    const [endpoint, body] = mockPost.mock.calls[0];
    expect(endpoint).toBe('/api/access-grants/request');
    const typed = body as Record<string, unknown>;
    expect(typed.entity_type).toBe('data_product');
    expect(typed.entity_id).toBe('prod-1');
    expect(typed.wizard_data).toEqual({ custom_field: 'foo', urgency: 'high' });
    // The base payload comes from buildPayload — reason is empty because the
    // user never typed it (wizard was supposed to collect it). That's fine:
    // the wizard's user_action step writes its own reason into wizard_data.
    expect(typed.reason).toBe('');
  });

  it('shows wizard-configured notice and skips dialog-side validation when wizard is configured', async () => {
    mockLookupWorkflowId.mockResolvedValue('wf-portable-1');

    renderWithProviders(
      <RequestProductActionDialog
        isOpen={true}
        onOpenChange={vi.fn()}
        productId="prod-1"
        productName="Test Product"
        productStatus="active"
      />,
    );

    // Notice is rendered (uses the existing Alert + Info icon pattern).
    await waitFor(() => {
      expect(
        screen.getByText(/multi-step wizard is configured/i),
      ).toBeInTheDocument();
    });

    // Dialog's own access form is suppressed — no reason textarea anywhere.
    expect(document.getElementById('access-message')).toBeNull();

    // Click Continue with no input — wizard should open (no validation error).
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await waitFor(() => {
      expect(screen.getByTestId('wizard-mock')).toBeInTheDocument();
    });
    // No "Please provide a reason" error rendered since validation was skipped.
    expect(screen.queryByText(/Please provide a reason/i)).toBeNull();
  });

  it('preserves direct-status-change form when canDirectStatusChange is true (skips wizard lookup)', async () => {
    mockLookupWorkflowId.mockResolvedValue('wf-not-used');

    renderWithProviders(
      <RequestProductActionDialog
        isOpen={true}
        onOpenChange={vi.fn()}
        productId="prod-1"
        productName="Test Product"
        productStatus="draft"
        defaultRequestType="status_change"
        canDirectStatusChange={true}
      />,
    );

    // Direct status change must NOT trigger the wizard lookup at open time
    // (admin path bypasses the wizard regardless of config).
    await new Promise((r) => setTimeout(r, 0));
    expect(mockLookupWorkflowId).not.toHaveBeenCalled();
    // No wizard-configured notice.
    expect(screen.queryByText(/multi-step wizard is configured/i)).toBeNull();
    // Submit button stays as direct-change variant.
    expect(screen.getByRole('button', { name: /Change Status/ })).toBeInTheDocument();
  });

  it('skips the wizard for direct status changes (canDirectStatusChange=true)', async () => {
    mockLookupWorkflowId.mockResolvedValue('wf-not-used');

    renderWithProviders(
      <RequestProductActionDialog
        isOpen={true}
        onOpenChange={vi.fn()}
        productId="prod-1"
        productName="Test Product"
        productStatus="draft"
        defaultRequestType="status_change"
        canDirectStatusChange={true}
      />,
    );

    // Direct status changes don't go through validation gates other than
    // target_status — but the validateForm path requires it, so this test
    // only asserts the wizard isn't even queried (lookup never fires for
    // direct-status-change). Submit doesn't have to succeed for that.
    fireEvent.click(screen.getByRole('button', { name: /Change Status/ }));
    // Give microtasks a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockLookupWorkflowId).not.toHaveBeenCalled();
  });
});
