import { HexColorPicker } from 'react-colorful'

interface ColorPickerProps {
  color: string
  onChange: (color: string) => void
}

export function ColorPicker({ color, onChange }: ColorPickerProps) {
  return (
    <div className="p-2">
      <HexColorPicker color={color} onChange={onChange} />
    </div>
  )
}
