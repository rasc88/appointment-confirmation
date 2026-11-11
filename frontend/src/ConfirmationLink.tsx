import { useState } from 'react';

type CopyNotice = { isError: false; text: string } | { isError: true };

/** Shown after create and after regenerate, the only times the API returns the link. */
export function ConfirmationLink({ confirmationLink, message }: { confirmationLink: string; message: string }) {
  const [notice, setNotice] = useState<CopyNotice | null>(null);

  async function copy(text: string, successText: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ isError: false, text: successText });
    } catch {
      setNotice({ isError: true });
    }
  }

  return (
    <div className="confirmation-link">
      <dl className="copy-texts">
        <dt>Link</dt>
        <dd>{confirmationLink}</dd>
        <dt>Message</dt>
        <dd>{message}</dd>
      </dl>
      <div className="button-row">
        <button type="button" onClick={() => copy(confirmationLink, 'Link copied.')}>
          Copy link
        </button>
        <button type="button" onClick={() => copy(message, 'Message copied.')}>
          Copy message
        </button>
      </div>
      {notice && !notice.isError && <p role="status">{notice.text}</p>}
      {notice?.isError && <p role="alert">Could not copy. Select the text above and copy it yourself.</p>}
    </div>
  );
}
