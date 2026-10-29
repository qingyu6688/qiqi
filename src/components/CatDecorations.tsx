interface DecorationProps {
  className?: string
}

export function CatHeadIcon({ className = '' }: DecorationProps) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`pointer-events-none shrink-0 ${className}`}>
      <path d="M5 9.5 4 3l6 3.2a12 12 0 0 1 4 0L20 3l-1 6.5c1.3 1.3 2 3 2 5 0 4.2-4 7-9 7s-9-2.8-9-7c0-2 .7-3.7 2-5Z" />
      <path d="M7.3 12.5c.6-.6 1.4-.6 2 0m5.4 0c.6-.6 1.4-.6 2 0M12 16v.6m0 0c-.8 1.2-2 1-2.5.3m2.5-.3c.8 1.2 2 1 2.5.3M5.5 15 2 14.5m4 2.8-3 .7M18.5 15l3.5-.5m-4 2.8 3 .7" />
      <path d="m11 15 1 1 1-1" />
    </svg>
  )
}

export function PawIcon({ className = '' }: DecorationProps) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="currentColor" className={`pointer-events-none shrink-0 ${className}`}>
      <ellipse cx="4.8" cy="9" rx="2" ry="2.8" transform="rotate(-25 4.8 9)" />
      <ellipse cx="9.3" cy="5.8" rx="2.1" ry="2.8" transform="rotate(-8 9.3 5.8)" />
      <ellipse cx="14.7" cy="5.8" rx="2.1" ry="2.8" transform="rotate(8 14.7 5.8)" />
      <ellipse cx="19.2" cy="9" rx="2" ry="2.8" transform="rotate(25 19.2 9)" />
      <path d="M12 11.5c-2.4 0-3.2 2-4.8 3.4-1.4 1.3-2.5 2.5-2 4.1.7 2.5 3.5 2.4 5.1 1.5 1.1-.6 2.3-.6 3.4 0 1.6.9 4.4 1 5.1-1.5.5-1.6-.6-2.8-2-4.1-1.6-1.4-2.4-3.4-4.8-3.4Z" />
    </svg>
  )
}

export function CatCompanion({ className = '' }: DecorationProps) {
  return (
    <div aria-hidden="true" className={`pointer-events-none relative mx-auto mb-5 h-24 w-36 select-none text-[#8c6755] dark:text-[#d6b5a3] ${className}`}>
      <div className="absolute left-7 top-0 rounded-full bg-[#8c6755]/[0.06] p-3 dark:bg-[#d6b5a3]/[0.06]">
        <CatHeadIcon className="h-16 w-16" />
      </div>
      <PawIcon className="absolute bottom-0 left-0 h-6 w-6 -rotate-[25deg] opacity-30" />
      <PawIcon className="absolute right-0 top-3 h-4 w-4 rotate-[22deg] opacity-25" />
    </div>
  )
}

export function PawTrail({ className = '' }: DecorationProps) {
  return (
    <span aria-hidden="true" className={`pointer-events-none inline-flex items-center gap-2 text-[#8c6755] dark:text-[#d6b5a3] ${className}`}>
      <PawIcon className="h-4 w-4 -rotate-[25deg] opacity-20" />
      <PawIcon className="mb-3 h-4 w-4 -rotate-[12deg] opacity-35" />
      <PawIcon className="h-4 w-4 rotate-[15deg] opacity-50" />
    </span>
  )
}
