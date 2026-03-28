import { useEditor, EditorContent } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'

interface RichTextEditorProps {
  content: string
  onChange: (html: string) => void
  placeholder?: string
  txtColor: string
  isLight: boolean
  editable?: boolean
}

export function RichTextEditor({ content, onChange, placeholder, txtColor, isLight, editable = true }: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Underline,
      Link.configure({ openOnClick: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: placeholder ?? 'Add description...' }),
    ],
    content,
    editable,
    onUpdate: ({ editor }) => {
      onChange(editor.getHTML())
    },
  })

  if (!editor) return null

  const bubbleBg = isLight ? 'rgba(255,255,255,0.95)' : 'rgba(20,20,30,0.95)'

  const btnStyle = (active: boolean): React.CSSProperties => ({
    color: txtColor,
    opacity: active ? 1 : 0.5,
    backgroundColor: active ? (isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.12)') : 'transparent',
  })

  return (
    <div>
      {editable && (
        <BubbleMenu
          editor={editor}
          tippyOptions={{ duration: 150 }}
          className="flex items-center gap-0.5 px-1.5 py-1 rounded-lg shadow-xl border"
          style={{
            backgroundColor: bubbleBg,
            borderColor: `${txtColor}15`,
            backdropFilter: 'blur(12px)',
          }}
        >
          {/* Heading dropdown */}
          <select
            value={
              editor.isActive('heading', { level: 1 }) ? 'h1' :
              editor.isActive('heading', { level: 2 }) ? 'h2' :
              editor.isActive('heading', { level: 3 }) ? 'h3' : 'p'
            }
            onChange={(e) => {
              const v = e.target.value
              if (v === 'p') editor.chain().focus().setParagraph().run()
              else editor.chain().focus().toggleHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run()
            }}
            className="text-[11px] px-1.5 py-1 rounded-md border-none appearance-none cursor-pointer"
            style={{ ...btnStyle(false), backgroundColor: isLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)' }}
          >
            <option value="p" style={{ backgroundColor: isLight ? '#fff' : '#111' }}>Aa</option>
            <option value="h1" style={{ backgroundColor: isLight ? '#fff' : '#111' }}>H1</option>
            <option value="h2" style={{ backgroundColor: isLight ? '#fff' : '#111' }}>H2</option>
            <option value="h3" style={{ backgroundColor: isLight ? '#fff' : '#111' }}>H3</option>
          </select>

          <Btn label="B" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} style={btnStyle} bold />
          <Btn label="I" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} style={btnStyle} italic />
          <Btn label="S" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} style={btnStyle} strike />
          <Btn label="U" active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()} style={btnStyle} underline />

          <Sep txtColor={txtColor} />

          <Btn label="&#x201C;&#x201D;" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} style={btnStyle} />
          <Btn label="&lt;&gt;" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} style={btnStyle} mono />

          <Sep txtColor={txtColor} />

          <Btn label="&#x2022;" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} style={btnStyle} />
          <Btn label="1." active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} style={btnStyle} />
          <Btn label="&#x2713;" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()} style={btnStyle} />
        </BubbleMenu>
      )}

      <EditorContent
        editor={editor}
        className="tiptap-editor"
        style={{ color: txtColor }}
      />

      <style>{`
        .tiptap-editor .tiptap {
          outline: none;
          font-size: 14px;
          line-height: 1.6;
          min-height: ${editable ? '140px' : '0'};
          color: ${txtColor};
        }
        .tiptap-editor .tiptap p.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: ${txtColor};
          opacity: 0.3;
          pointer-events: none;
          height: 0;
        }
        .tiptap-editor .tiptap h1 { font-size: 1.25rem; font-weight: 700; margin: 0.75rem 0 0.5rem; }
        .tiptap-editor .tiptap h2 { font-size: 1.1rem; font-weight: 700; margin: 0.75rem 0 0.375rem; }
        .tiptap-editor .tiptap h3 { font-size: 1rem; font-weight: 600; margin: 0.5rem 0 0.25rem; }
        .tiptap-editor .tiptap p { margin-bottom: 0.5rem; }
        .tiptap-editor .tiptap ul { list-style: disc; padding-left: 1.25rem; margin-bottom: 0.5rem; }
        .tiptap-editor .tiptap ol { list-style: decimal; padding-left: 1.25rem; margin-bottom: 0.5rem; }
        .tiptap-editor .tiptap li { margin-bottom: 0.125rem; }
        .tiptap-editor .tiptap blockquote { border-left: 2px solid ${txtColor}40; padding-left: 0.75rem; margin: 0.5rem 0; opacity: 0.7; }
        .tiptap-editor .tiptap code { background: ${txtColor}10; padding: 0.125rem 0.25rem; border-radius: 0.25rem; font-size: 0.85em; font-family: monospace; }
        .tiptap-editor .tiptap pre { background: ${txtColor}10; padding: 0.75rem; border-radius: 0.375rem; margin: 0.5rem 0; overflow-x: auto; }
        .tiptap-editor .tiptap pre code { background: none; padding: 0; font-size: 0.8em; }
        .tiptap-editor .tiptap a { text-decoration: underline; opacity: 0.8; }
        .tiptap-editor .tiptap hr { border: none; height: 1px; background: ${txtColor}15; margin: 0.75rem 0; }
        .tiptap-editor .tiptap ul[data-type="taskList"] { list-style: none; padding-left: 0; }
        .tiptap-editor .tiptap ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 0.5rem; }
        .tiptap-editor .tiptap ul[data-type="taskList"] li label { margin-top: 0.15rem; }
        .tiptap-editor .tiptap ul[data-type="taskList"] li div { flex: 1; }
        .tiptap-editor .tiptap s { text-decoration: line-through; }
        .tiptap-editor .tiptap u { text-decoration: underline; }
      `}</style>
    </div>
  )
}

function Sep({ txtColor }: { txtColor: string }) {
  return <span className="w-px h-4 mx-0.5" style={{ backgroundColor: `${txtColor}15` }} />
}

function Btn({ label, active, onClick, style, bold, italic, strike, underline, mono }: {
  label: string
  active: boolean
  onClick: () => void
  style: (active: boolean) => React.CSSProperties
  bold?: boolean
  italic?: boolean
  strike?: boolean
  underline?: boolean
  mono?: boolean
}) {
  return (
    <button
      onMouseDown={(e) => { e.preventDefault(); onClick() }}
      className="text-[12px] px-1.5 py-1 rounded-md transition-colors min-w-[26px]"
      style={style(active)}
      dangerouslySetInnerHTML={{
        __html: `<span style="${bold ? 'font-weight:700;' : ''}${italic ? 'font-style:italic;' : ''}${strike ? 'text-decoration:line-through;' : ''}${underline ? 'text-decoration:underline;' : ''}${mono ? 'font-family:monospace;' : ''}">${label}</span>`
      }}
    />
  )
}
