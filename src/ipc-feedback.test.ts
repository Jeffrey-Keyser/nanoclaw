import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from './db/index.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
  };

  setRegisteredGroup('main@g.us', MAIN_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('feedback IPC operation', () => {
  it('rejects missing feedbackType', async () => {
    // Should not throw — just logs a warning and breaks
    await processTaskIpc(
      {
        type: 'feedback',
        title: 'A title',
        description: 'A description',
      } as any,
      'whatsapp_main',
      true,
      deps,
    );
    // No crash = pass
  });

  it('rejects invalid feedbackType without calling the registry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await processTaskIpc(
      {
        type: 'feedback',
        feedbackType: 'praise',
        title: 'A title',
        description: 'A description',
      },
      'whatsapp_main',
      true,
      deps,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects missing title', async () => {
    await processTaskIpc(
      {
        type: 'feedback',
        feedbackType: 'bug',
        description: 'A description',
      } as any,
      'whatsapp_main',
      true,
      deps,
    );
  });

  it('rejects missing description', async () => {
    await processTaskIpc(
      {
        type: 'feedback',
        feedbackType: 'feature',
        title: 'A title',
      } as any,
      'whatsapp_main',
      true,
      deps,
    );
  });

  it('POSTs valid bug feedback to the Feedback Registry', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: '123' }), { status: 201 }),
      );

    await processTaskIpc(
      {
        type: 'feedback',
        feedbackType: 'bug',
        title: 'Something is broken',
        description: 'Detailed description of the bug',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://feedback.jeffreykeyser.net/api/v1/feedback');
    expect(opts?.method).toBe('POST');

    const body = JSON.parse(opts?.body as string);
    expect(body).toEqual({
      appId: 'nanoclaw',
      type: 'bug',
      title: 'Something is broken',
      description: 'Detailed description of the bug',
      metadata: { source: 'nanoclaw', sourceGroup: 'whatsapp_main' },
    });
  });

  it('POSTs valid feature feedback with email', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: '456' }), { status: 201 }),
      );

    await processTaskIpc(
      {
        type: 'feedback',
        feedbackType: 'feature',
        title: 'Add dark mode',
        description: 'Would be nice to have dark mode',
        email: 'user@example.com',
      },
      'other-group',
      false,
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body).toEqual({
      appId: 'nanoclaw',
      type: 'feature',
      title: 'Add dark mode',
      description: 'Would be nice to have dark mode',
      email: 'user@example.com',
      metadata: { source: 'nanoclaw', sourceGroup: 'other-group' },
    });
  });

  it('handles fetch failure gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    // Should not throw
    await processTaskIpc(
      {
        type: 'feedback',
        feedbackType: 'bug',
        title: 'Test',
        description: 'Test description',
      },
      'whatsapp_main',
      true,
      deps,
    );
  });

  it('handles non-OK response gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Bad Request', { status: 400 }),
    );

    // Should not throw
    await processTaskIpc(
      {
        type: 'feedback',
        feedbackType: 'bug',
        title: 'Test',
        description: 'Test description',
      },
      'whatsapp_main',
      true,
      deps,
    );
  });

  it('does not include email when not provided', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 201 }));

    await processTaskIpc(
      {
        type: 'feedback',
        feedbackType: 'bug',
        title: 'No email',
        description: 'No email provided',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body).not.toHaveProperty('email');
  });

  it('POSTs question feedback (registry type) to the registry', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 201 }));

    await processTaskIpc(
      {
        type: 'feedback',
        feedbackType: 'question',
        title: 'How do scheduled tasks retry?',
        description: 'Is there a retry policy for failed scheduled tasks?',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body).toMatchObject({ appId: 'nanoclaw', type: 'question' });
  });

  it('honors FEEDBACK_REGISTRY_URL (trailing slash tolerated)', async () => {
    vi.stubEnv('FEEDBACK_REGISTRY_URL', 'http://127.0.0.1:4010/');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 201 }));

    try {
      await processTaskIpc(
        {
          type: 'feedback',
          feedbackType: 'bug',
          title: 'Override',
          description: 'Uses the configured registry',
        },
        'whatsapp_main',
        true,
        deps,
      );
    } finally {
      vi.unstubAllEnvs();
    }

    expect(fetchSpy.mock.calls[0][0]).toBe(
      'http://127.0.0.1:4010/api/v1/feedback',
    );
  });

  it('trims and caps the title at the registry limit of 255 characters', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 201 }));

    await processTaskIpc(
      {
        type: 'feedback',
        feedbackType: 'bug',
        title: `  ${'x'.repeat(300)}  `,
        description: 'Long title',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.title).toBe('x'.repeat(255));
  });

  it('rejects a whitespace-only title without calling the registry', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await processTaskIpc(
      {
        type: 'feedback',
        feedbackType: 'bug',
        title: '   ',
        description: 'Blank title',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
