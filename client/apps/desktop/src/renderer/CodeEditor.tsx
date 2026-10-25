import { basicSetup, EditorView } from 'codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { unifiedMergeView } from '@codemirror/merge'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'

export interface CursorPosition {
  line: number
  utf16Column: number
  utf8Offset: number
}

interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  onCursorChange?: (position: CursorPosition) => void
  readOnly?: boolean
  diffOriginal?: string
  ariaLabel: string
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--editor-background)',
    color: 'var(--editor-foreground)',
    fontFamily: 'var(--font-ibm-plex-mono)',
    fontSize: '13px',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.62',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--accent)',
    padding: '14px 0 48px',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--editor-selection)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--editor-gutter)',
    color: 'var(--editor-gutter-foreground)',
    border: 'none',
    borderRight: '1px solid var(--separator)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'var(--editor-active-line)',
  },
  '.cm-foldGutter span': {
    color: 'var(--muted)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--overlay)',
    color: 'var(--overlay-foreground)',
    border: '1px solid var(--border)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--surface-secondary)',
    color: 'var(--surface-secondary-foreground)',
  },
  '.cm-changedLine': {
    backgroundColor: 'var(--diff-added-background)',
  },
  '.cm-deletedChunk': {
    backgroundColor: 'var(--diff-deleted-background)',
  },
  '.cm-insertedLine': {
    backgroundColor: 'var(--diff-added-background)',
  },
  '.cm-changeGutter': {
    width: '3px',
  },
})

const editorHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.modifier], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.regexp], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: 'var(--syntax-function)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--syntax-type)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--syntax-property)' },
  { tag: tags.variableName, color: 'var(--editor-foreground)' },
  { tag: tags.invalid, color: 'var(--danger)', textDecoration: 'underline' },
])

const textEncoder = new TextEncoder()

export function CodeEditor({
  value,
  onChange,
  onCursorChange,
  readOnly = false,
  diffOriginal,
  ariaLabel,
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const onCursorChangeRef = useRef(onCursorChange)

  onChangeRef.current = onChange
  onCursorChangeRef.current = onCursorChange

  useEffect(() => {
    if (!containerRef.current) {
      return
    }

    const diffExtensions =
      diffOriginal === undefined
        ? []
        : unifiedMergeView({
            original: diffOriginal,
            highlightChanges: true,
            gutter: true,
            syntaxHighlightDeletions: true,
            allowInlineDiffs: true,
            mergeControls: false,
            collapseUnchanged: { margin: 3, minSize: 6 },
          })

    const view = new EditorView({
      doc: value,
      parent: containerRef.current,
      extensions: [
        basicSetup,
        javascript({ jsx: true, typescript: true }),
        syntaxHighlighting(editorHighlightStyle),
        editorTheme,
        EditorView.editable.of(!readOnly),
        EditorView.contentAttributes.of({
          'aria-label': ariaLabel,
          'data-editor-kind': diffOriginal === undefined ? 'source' : 'diff',
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString())
          }

          if (update.docChanged || update.selectionSet) {
            const offset = update.state.selection.main.head
            const line = update.state.doc.lineAt(offset)
            onCursorChangeRef.current?.({
              line: line.number,
              utf16Column: offset - line.from + 1,
              utf8Offset: textEncoder.encode(update.state.doc.sliceString(0, offset)).length,
            })
          }
        }),
        ...diffExtensions,
      ],
    })

    viewRef.current = view
    const selection = view.state.selection.main.head
    const line = view.state.doc.lineAt(selection)
    onCursorChangeRef.current?.({
      line: line.number,
      utf16Column: selection - line.from + 1,
      utf8Offset: textEncoder.encode(view.state.doc.sliceString(0, selection)).length,
    })

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [ariaLabel, diffOriginal, readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (!view) {
      return
    }

    const currentValue = view.state.doc.toString()
    if (currentValue === value) {
      return
    }

    view.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: value,
      },
    })
  }, [value])

  return <div className="code-editor" ref={containerRef} />
}
