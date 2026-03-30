<template>
  <div v-if="renderError" class="node-error p-1 text-xs text-red-500">⚠️</div>
  <div
    v-else
    :class="
      cn(
        'lg-slot lg-slot--input group/slot m-0 flex items-center rounded-r-lg',
        'cursor-crosshair',
        dotOnly ? 'lg-slot--dot-only' : 'pr-6',
        {
          'lg-slot--connected': props.connected,
          'lg-slot--compatible': props.compatible,
          'opacity-40': shouldDim
        },
        props.socketless && 'pointer-events-none invisible'
      )
    "
  >
    <!-- Connection Dot -->
    <SlotConnectionDot
      ref="connectionDotRef"
      v-tooltip.left="tooltipConfig"
      :class="
        cn(
          'w-3 -translate-x-1/2',
          hasError &&
            'before:pointer-events-none before:absolute before:size-4 before:rounded-full before:ring-2 before:ring-error before:ring-offset-0'
        )
      "
      :slot-data
      @click="onClick"
      @dblclick="onDoubleClick"
      @pointerdown="onPointerDown"
      @contextmenu.stop.prevent="showSlotMenu"
    />

    <!-- Slot Name -->
    <div class="flex h-full min-w-0 items-center">
      <EditableText
        v-if="!props.dotOnly && !hasNoLabel"
        :model-value="displayLabel"
        :is-editing="isRenaming"
        label-class="truncate text-node-component-slot-text hover:text-node-component-slot-text-highlight"
        @edit="handleRenameEdit"
        @cancel="isRenaming = false"
        @dblclick.stop="startRename"
      />
    </div>

    <!-- Slot context menu -->
    <div
      v-if="showMenu"
      ref="menuRef"
      class="border-border bg-popover fixed z-50 min-w-32 rounded-md border p-1 shadow-md"
      :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px' }"
      @click.stop
      @contextmenu.stop.prevent
    >
      <button
        class="text-popover-foreground hover:bg-accent flex w-full items-center gap-2 rounded-sm px-3 py-1.5 text-sm"
        @click="handleMenuRename"
      >
        {{ t('g.rename') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onErrorCaptured,
  onMounted,
  ref,
  watchEffect
} from 'vue'
import type { ComponentPublicInstance } from 'vue'

import { useI18n } from 'vue-i18n'

import EditableText from '@/components/common/EditableText.vue'
import { useErrorHandling } from '@/composables/useErrorHandling'
import type { INodeSlot } from '@/lib/litegraph/src/litegraph'
import { NodeSlotType } from '@/lib/litegraph/src/types/globalEnums'
import { useSlotLinkDragUIState } from '@/renderer/core/canvas/links/slotLinkDragUIState'
import { getSlotKey } from '@/renderer/core/layout/slots/slotIdentifier'
import { useNodeTooltips } from '@/renderer/extensions/vueNodes/composables/useNodeTooltips'
import { useSlotElementTracking } from '@/renderer/extensions/vueNodes/composables/useSlotElementTracking'
import { useSlotLinkInteraction } from '@/renderer/extensions/vueNodes/composables/useSlotLinkInteraction'
import { app } from '@/scripts/app'
import { cn } from '@/utils/tailwindUtil'

import SlotConnectionDot from './SlotConnectionDot.vue'

interface InputSlotProps {
  slotData: INodeSlot
  compatible?: boolean
  connected?: boolean
  dotOnly?: boolean
  hasError?: boolean
  index: number
  nodeType?: string
  nodeId?: string
  socketless?: boolean
}

const props = defineProps<InputSlotProps>()
const { t } = useI18n()

const labelOverride = ref<string | null>(null)
const displayLabel = computed(
  () =>
    labelOverride.value ||
    props.slotData.label ||
    props.slotData.localized_name ||
    (props.slotData.name ?? `Input ${props.index}`)
)

const hasNoLabel = computed(
  () =>
    !props.slotData.label &&
    !props.slotData.localized_name &&
    props.slotData.name === ''
)
const dotOnly = computed(() => props.dotOnly || hasNoLabel.value)

const renderError = ref<string | null>(null)
const { toastErrorHandler } = useErrorHandling()

const { getInputSlotTooltip, createTooltipConfig } = useNodeTooltips(
  props.nodeType || ''
)

const tooltipConfig = computed(() => {
  const slotName = props.slotData.localized_name || props.slotData.name || ''
  const tooltipText = getInputSlotTooltip(slotName)
  const fallbackText = tooltipText || `Input: ${slotName}`
  return createTooltipConfig(fallbackText)
})

onErrorCaptured((error) => {
  renderError.value = error.message
  toastErrorHandler(error)
  return false
})

const { state: dragState } = useSlotLinkDragUIState()
const slotKey = computed(() =>
  getSlotKey(props.nodeId ?? '', props.index, true)
)
const shouldDim = computed(() => {
  if (!dragState.active) return false
  return !dragState.compatible.get(slotKey.value)
})

const connectionDotRef = ref<ComponentPublicInstance<{
  slotElRef: HTMLElement | undefined
}> | null>(null)
const slotElRef = ref<HTMLElement | null>(null)

watchEffect(() => {
  const el = connectionDotRef.value?.slotElRef
  slotElRef.value = el || null
})

useSlotElementTracking({
  nodeId: props.nodeId ?? '',
  index: props.index,
  type: 'input',
  element: slotElRef
})

const { onClick, onDoubleClick, onPointerDown } = useSlotLinkInteraction({
  nodeId: props.nodeId ?? '',
  index: props.index,
  type: 'input'
})

// ── Inline rename ─────────────────────────────────────────────
const isRenaming = ref(false)

function startRename() {
  if (props.slotData.nameLocked) return
  isRenaming.value = true
}

function handleRenameEdit(newLabel: string) {
  isRenaming.value = false
  const trimmed = newLabel.trim()
  if (!trimmed || trimmed === displayLabel.value) return

  const node = app.canvas?.graph?.getNodeById(props.nodeId ?? '')
  const slot = node?.inputs?.[props.index]
  if (!slot) return

  slot.label = trimmed
  labelOverride.value = trimmed
  node?.graph?.trigger('node:slot-label:changed', {
    nodeId: node.id,
    slotType: NodeSlotType.INPUT
  })
  app.canvas?.setDirty(true, true)
}

// ── Context menu ──────────────────────────────────────────────
const showMenu = ref(false)
const menuPos = ref({ x: 0, y: 0 })
const menuRef = ref<HTMLElement | null>(null)

function showSlotMenu(event: MouseEvent) {
  if (props.slotData.nameLocked) return
  menuPos.value = { x: event.clientX, y: event.clientY }
  showMenu.value = true
}

function handleMenuRename() {
  showMenu.value = false
  startRename()
}

function handleClickOutside(event: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(event.target as Node)) {
    showMenu.value = false
  }
}

onMounted(() => document.addEventListener('click', handleClickOutside))
onBeforeUnmount(() => document.removeEventListener('click', handleClickOutside))
</script>
