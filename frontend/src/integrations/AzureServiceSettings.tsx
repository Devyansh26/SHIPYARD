import { Field } from '../components/ui'
import { inputCls } from '../lib/meta'
import { type AzureMeta, type AzureServiceKind, type ServiceType } from '../lib/types'

const AZURE_REGIONS = [
  { value: 'eastus', label: 'East US (eastus)' },
  { value: 'eastus2', label: 'East US 2 (eastus2)' },
  { value: 'westus2', label: 'West US 2 (westus2)' },
  { value: 'centralus', label: 'Central US (centralus)' },
  { value: 'westeurope', label: 'West Europe (westeurope)' },
  { value: 'northeurope', label: 'North Europe (northeurope)' },
  { value: 'southeastasia', label: 'Southeast Asia (southeastasia)' },
  { value: 'centralindia', label: 'Central India (centralindia)' },
]

const RUNTIME_STACKS = [
  'NODE|20-lts',
  'NODE|22-lts',
  'PYTHON|3.12',
  'PYTHON|3.11',
  'DOTNETCORE|8.0',
]

type Props = {
  serviceType: ServiceType
  value: AzureMeta
  onChange: (next: AzureMeta) => void
}

export default function AzureServiceSettings({ serviceType, value, onChange }: Props) {
  const kind: AzureServiceKind = value.serviceKind
    ?? (serviceType === 'frontend' ? 'static_web_apps' : 'app_service')

  const update = (patch: Partial<AzureMeta>) => onChange({ ...value, serviceKind: kind, ...patch })

  const availableKinds: { value: AzureServiceKind; label: string }[] = serviceType === 'frontend'
    ? [
      { value: 'static_web_apps', label: 'Azure Static Web Apps' },
      { value: 'app_service', label: 'Azure App Service' },
    ]
    : [
      { value: 'app_service', label: 'Azure App Service' },
      { value: 'container_apps', label: 'Azure Container Apps' },
    ]

  return (
    <div className="space-y-3 rounded-xl border border-line bg-sunken p-3.5">
      <Field label="Azure service">
        <select
          className={inputCls}
          value={kind}
          onChange={(e) => update({ serviceKind: e.target.value as AzureServiceKind })}
        >
          {availableKinds.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-2.5">
        <Field label="Region">
          <select
            className={inputCls}
            value={value.location || 'eastus'}
            onChange={(e) => update({ location: e.target.value })}
          >
            {AZURE_REGIONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Resource group" hint="Auto-created if absent">
          <input
            className={`${inputCls} font-mono`}
            placeholder="shipyard-project-rg"
            value={value.resourceGroup || ''}
            onChange={(e) => update({ resourceGroup: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Azure app / site name" hint="Optional — defaults to a slug of the service name">
        <input
          className={`${inputCls} font-mono`}
          placeholder="sy-my-service"
          value={value.appName || ''}
          onChange={(e) => update({ appName: e.target.value })}
        />
      </Field>

      {kind === 'app_service' && (
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Runtime stack">
            <select
              className={`${inputCls} font-mono`}
              value={value.runtimeStack || 'NODE|20-lts'}
              onChange={(e) => update({ runtimeStack: e.target.value })}
            >
              {RUNTIME_STACKS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="App Service SKU">
            <select
              className={`${inputCls} font-mono`}
              value={value.sku || 'B1'}
              onChange={(e) => update({ sku: e.target.value })}
            >
              <option value="F1">F1 (Free)</option>
              <option value="B1">B1 (Basic)</option>
              <option value="B2">B2 (Basic)</option>
              <option value="S1">S1 (Standard)</option>
            </select>
          </Field>
        </div>
      )}

      {kind === 'container_apps' && (
        <div className="grid grid-cols-2 gap-2.5">
          <Field label="Target port">
            <input
              className={`${inputCls} font-mono`}
              type="number"
              min={1}
              max={65535}
              placeholder="3000"
              value={value.port ?? 3000}
              onChange={(e) => update({ port: Number.parseInt(e.target.value, 10) || 3000 })}
            />
          </Field>
          <Field label="Container image (optional)" hint="Blank = build Dockerfile via ACR">
            <input
              className={`${inputCls} font-mono`}
              placeholder="ghcr.io/org/app:latest"
              value={value.containerImage || ''}
              onChange={(e) => update({ containerImage: e.target.value })}
            />
          </Field>
        </div>
      )}

      {kind === 'static_web_apps' && (
        <Field label="Output location" hint="Relative to app location (e.g. dist, build, out)">
          <input
            className={`${inputCls} font-mono`}
            placeholder="dist"
            value={value.outputLocation || ''}
            onChange={(e) => update({ outputLocation: e.target.value })}
          />
        </Field>
      )}
    </div>
  )
}
