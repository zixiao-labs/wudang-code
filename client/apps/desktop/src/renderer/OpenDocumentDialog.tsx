import { FileCode, Xmark } from '@gravity-ui/icons'
import { Button } from '@heroui/react/button'
import { useEffect, useRef, useState } from 'react'
import type { ServerWorkspace } from './useServerWorkspace'

export function OpenDocumentDialog({
  workspace: w,
  open,
  onClose,
  onOpened,
}: {
  workspace: ServerWorkspace
  open: boolean
  onClose: () => void
  onOpened: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [workspaceId, setWorkspaceId] = useState('')
  const [documentId, setDocumentId] = useState('')

  useEffect(() => {
    if (open) {
      setWorkspaceId(w.document?.workspaceId ?? '')
      setDocumentId(w.document?.documentId ?? '')
      dialog.current?.showModal()
    } else dialog.current?.close()
  }, [open, w.document?.workspaceId, w.document?.documentId])

  return (
    <dialog
      ref={dialog}
      className="open-dialog"
      aria-labelledby="open-document-title"
      onCancel={(event) => {
        if (w.busy) event.preventDefault()
        else onClose()
      }}
      onClose={onClose}
    >
      <div className="dialog-heading">
        <span>
          <FileCode aria-hidden />
          <h2 id="open-document-title">Open document</h2>
        </span>
        <Button
          aria-label="Close dialog"
          className="icon-button"
          isIconOnly
          size="sm"
          variant="ghost"
          isDisabled={w.busy}
          onPress={onClose}
        >
          <Xmark aria-hidden />
        </Button>
      </div>
      <p>Pick up where you left off, or start a shared document.</p>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (w.dirty && !confirm('Discard your unsaved draft and load the server document?'))
            return
          void w.open(documentId.trim(), workspaceId.trim()).then((success) => {
            if (success) {
              onClose()
              onOpened()
            }
          })
        }}
      >
        <fieldset disabled={w.busy}>
          <label>
            Workspace ID
            <input
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.target.value)}
              placeholder="my-workspace"
              required
              pattern=".*\S.*"
            />
          </label>
          <label>
            Document ID
            <input
              value={documentId}
              onChange={(event) => setDocumentId(event.target.value)}
              placeholder="my-document"
              required
              pattern=".*\S.*"
            />
          </label>
          <p className="field-hint">
            Use the same IDs on another desktop to collaborate. A new document ID starts empty; it
            is not a local file path.
          </p>
          {w.error && (
            <p className="form-notice error-notice" role="alert">
              {w.error}
            </p>
          )}
          <div className="form-actions">
            <Button variant="ghost" onPress={onClose}>
              Cancel
            </Button>
            <Button type="submit" isPending={w.busy}>
              {w.busy ? 'Opening…' : 'Open document'}
            </Button>
          </div>
        </fieldset>
      </form>
    </dialog>
  )
}
