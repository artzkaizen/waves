import { useEffect, useRef, useState } from 'react'
import { Minus, Plus, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

type SettingsPopoverProps = {
  server: string
  onServerChange: (value: string) => void
  sessionSeconds: number
  onSessionSecondsChange: (value: number) => void
  demoMode: boolean
  onDemoModeChange: (value: boolean) => void
}

const MIN_SECONDS = 0
const MAX_SECONDS = 60

/** Header settings popover: server URL, default session duration, and demo mode. */
export function SettingsPopover({
  server,
  onServerChange,
  sessionSeconds,
  onSessionSecondsChange,
  demoMode,
  onDemoModeChange,
}: SettingsPopoverProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const step = (delta: number) =>
    onSessionSecondsChange(
      Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, sessionSeconds + delta)),
    )

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Button
        variant="outline"
        size="icon"
        aria-label="Settings"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Settings />
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Server settings"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            zIndex: 50,
            width: 288,
            background: 'var(--popover)',
            color: 'var(--popover-foreground)',
            border: '1px solid var(--border)',
            borderRadius: 16,
            boxShadow:
              '0 10px 30px -12px rgba(0,0,0,.25), 0 2px 6px rgba(0,0,0,.06)',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--muted-foreground)',
                textTransform: 'uppercase',
                letterSpacing: '.04em',
              }}
            >
              Server
            </span>
            <Input
              value={server}
              onChange={(e) => onServerChange(e.target.value)}
              placeholder="localhost:8000"
            />
            <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
              host, host:port, or a ws:// URL · :8000 default
            </span>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                Session duration
              </span>
              <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
                0 = open-ended
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                aria-label="Decrease duration"
                disabled={sessionSeconds <= MIN_SECONDS}
                onClick={() => step(-1)}
              >
                <Minus />
              </Button>
              <span
                style={{
                  width: 44,
                  textAlign: 'center',
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {sessionSeconds === 0 ? 'open' : `${sessionSeconds}s`}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                aria-label="Increase duration"
                disabled={sessionSeconds >= MAX_SECONDS}
                onClick={() => step(1)}
              >
                <Plus />
              </Button>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>Demo mode</span>
              <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
                Run the built-in simulator
              </span>
            </div>
            <Switch
              checked={demoMode}
              onCheckedChange={onDemoModeChange}
              aria-label="Demo mode"
            />
          </div>
        </div>
      )}
    </div>
  )
}
