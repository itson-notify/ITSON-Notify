
export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="px-4 md:px-0">
      <h1 className="text-[24px] md:text-[32px] leading-tight font-semibold text-[#111827] tracking-[-0.02em]">{title}</h1>
      {subtitle && <p className="text-[14px] text-[#64748B] mt-1">{subtitle}</p>}
    </div>
  )
}
