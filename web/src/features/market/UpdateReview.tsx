import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Field } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { UpdateItem } from './api'

export function UpdateReview({ items, busy, onResolve }: {
  items: UpdateItem[]
  busy: boolean
  onResolve: (item: UpdateItem, choice: string) => void
}) {
  const { t } = useTranslation()
  return <section className="flex min-w-0 flex-col gap-3" aria-label={t('market.update.review')}>
    <p className="text-sm text-muted-foreground">{t('market.update.help')}</p>
    <ul className="divide-y rounded-lg border">
      {items.map((item) => <li key={JSON.stringify([item.resource_id, item.member_id])} className="flex min-w-0 flex-col gap-2 p-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="min-w-0 break-words [overflow-wrap:anywhere]">{item.name}</span>
          <Badge variant="outline">{t(`market.update.states.${item.state}`)}</Badge>
        </div>
        {item.conflict && <Field>
          <Select value={item.resolution || 'pending'} disabled={busy} onValueChange={value => onResolve(item, value === 'pending' ? '' : value)}>
            <SelectTrigger aria-label={t('market.update.resolve', { name: item.name })} id={`resolution-${item.resource_id}-${item.member_id || ''}`} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="pending">{t('market.update.pending')}</SelectItem>
              <SelectItem value="keep">{t('market.update.keep')}</SelectItem>
              <SelectItem value="remote">{t('market.update.remote')}</SelectItem>
            </SelectGroup></SelectContent>
          </Select>
        </Field>}
      </li>)}
    </ul>
  </section>
}
