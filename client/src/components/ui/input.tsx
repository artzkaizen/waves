import * as React from 'react'
import { cn } from '@/lib/utils'

/** ProcurisUI Input — rounded-4xl pill, semantic tokens, token-driven focus ring. */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type ?? 'text'}
      data-slot="input"
      className={cn(
        'flex h-10 w-full min-w-0 rounded-4xl border border-input bg-background px-4 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow]',
        'placeholder:text-muted-foreground',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
