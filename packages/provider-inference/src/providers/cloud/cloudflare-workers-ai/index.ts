import { createWorkersAI } from '@xsai-ext/providers/special/create'
import { z } from 'zod'

import { defineProvider } from '../../registry'

const cloudflareWorkersAIConfigSchema = z.object({
  apiKey: z.string('API Key'),
  accountId: z.string('Account ID'),
})

type CloudflareWorkersAIConfig = z.input<typeof cloudflareWorkersAIConfigSchema>

export const providerCloudflareWorkersAI = defineProvider<CloudflareWorkersAIConfig, 'cloudflare-workers-ai'>({
  id: 'cloudflare-workers-ai',
  name: 'Cloudflare Workers AI',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.cloudflare-workers-ai.title'),
  description: 'Cloudflare Workers AI with account-scoped credentials.',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.cloudflare-workers-ai.description'),
  tasks: ['chat'],
  icon: 'i-simple-icons:cloudflare',
  iconColor: 'i-lobe-icons:cloudflare-color',

  createProviderConfig: ({ t }) => cloudflareWorkersAIConfigSchema.extend({
    apiKey: cloudflareWorkersAIConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.provider.cloudflare-workers-ai.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    accountId: cloudflareWorkersAIConfigSchema.shape.accountId.meta({
      labelLocalized: t('settings.pages.providers.provider.cloudflare-workers-ai.fields.field.account-id.label'),
      descriptionLocalized: t('settings.pages.providers.provider.cloudflare-workers-ai.fields.field.account-id.description'),
      placeholderLocalized: t('settings.pages.providers.provider.cloudflare-workers-ai.fields.field.account-id.placeholder'),
    }),
  }),
  createProvider(config) {
    return createWorkersAI(config.apiKey, config.accountId)
  },
  // The provider has no model list request, so the settings page found no model.
  // Return the common Workers AI chat models. The model picker also accepts a custom model ID.
  extraMethods: {
    async listModels() {
      return [
        {
          id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
          name: 'Llama 3.3 70B Instruct (fast)',
          provider: 'cloudflare-workers-ai',
          description: 'Large general chat model from Meta. Stella uses it by default.',
        },
        {
          id: '@cf/meta/llama-3.1-8b-instruct',
          name: 'Llama 3.1 8B Instruct',
          provider: 'cloudflare-workers-ai',
          description: 'Small and quick chat model from Meta.',
        },
        {
          id: '@cf/meta/llama-4-scout-17b-16e-instruct',
          name: 'Llama 4 Scout 17B',
          provider: 'cloudflare-workers-ai',
          description: 'Mixture-of-experts chat model from Meta.',
        },
        {
          id: '@cf/mistralai/mistral-small-3.1-24b-instruct',
          name: 'Mistral Small 3.1 24B',
          provider: 'cloudflare-workers-ai',
          description: 'Mid-size chat model from Mistral.',
        },
        {
          id: '@cf/google/gemma-3-12b-it',
          name: 'Gemma 3 12B',
          provider: 'cloudflare-workers-ai',
          description: 'Mid-size chat model from Google.',
        },
        {
          id: '@cf/openai/gpt-oss-120b',
          name: 'GPT-OSS 120B',
          provider: 'cloudflare-workers-ai',
          description: 'Large open-weight reasoning model from OpenAI.',
        },
        {
          id: '@cf/openai/gpt-oss-20b',
          name: 'GPT-OSS 20B',
          provider: 'cloudflare-workers-ai',
          description: 'Small open-weight reasoning model from OpenAI.',
        },
      ]
    },
  },
  validationRequiredWhen: (config) => {
    return !!config.apiKey && !!config.accountId
  },
  validators: {
    validateConfig: [
      ({ t }) => ({
        id: 'cloudflare-workers-ai:check-config',
        name: t('settings.pages.providers.catalog.edit.validators.openai-compatible.check-config.title'),
        validator: async (config) => {
          const errors: Array<{ error: unknown }> = []
          const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
          const accountId = typeof config.accountId === 'string' ? config.accountId.trim() : ''

          if (!apiKey)
            errors.push({ error: new Error('API token is required.') })
          if (!accountId)
            errors.push({ error: new Error('Account ID is required.') })

          return {
            errors,
            reason: errors.length > 0 ? errors.map(item => (item.error as Error).message).join(', ') : '',
            reasonKey: '',
            valid: errors.length === 0,
          }
        },
      }),
    ],
  },
})
