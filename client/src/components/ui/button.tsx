import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * ProcurisUI Button — shadcn "base-maia" primitive.
 * House style is very round (rounded-4xl pills). Adds a `loading` state that
 * swaps a spinner + optional message in, matching the design's `loading` /
 * `loading-message` props.
 */
const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-4xl text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline:
          'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-5 py-2',
        sm: 'h-[30px] gap-1.5 px-3.5 text-[13px]',
        lg: 'h-11 px-6 text-[15px]',
        icon: 'size-10',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    loading?: boolean
    loadingMessage?: string
  }

function Button({
  className,
  variant,
  size,
  loading = false,
  loadingMessage,
  disabled,
  children,
  type,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 className="animate-spin" aria-hidden="true" />}
      {loading && loadingMessage ? loadingMessage : children}
    </button>
  )
}

export { Button }
export type { ButtonProps }
