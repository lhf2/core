import { DebuggerOptions, ReactiveEffect } from './effect'
import { Ref, trackRefValue, triggerRefValue } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'
import { Dep } from './dep'

declare const ComputedRefSymbol: unique symbol


export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
  [ComputedRefSymbol]: true
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (...args: any[]) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

/*
*  创建一个 computed effect；
*  计算属性有两个特点：
*  1. 惰性求值（lazy）：在需要的时候才会计算；
*     可以看到 effect 里面有一句判断 !options.lazy 的时候才会执行 effect.run()，直接 get 响应式的值；
*     但计算属性的 lazy = true; 所以只有 get 的时候并且 _dirty = true 才会触发 computed effect.run()，也就是传入的 getter 获取值；
*  2. 缓存机制（_dirty）：如果计算属性所依赖的值不变的话不会重新计算，直接返回缓存结果；
*     使用 _dirty 结合 effect scheduler 实现；初始值 _dirty = true，get 的时候 _dirty = false，并触发 effect.run()，等下次 get 的时候 _dirty = false，直接返回值；
      如果内部值发生了改变，会触发响应式数据的 trigger, 因为有 scheduler,会执行 scheduler，设置 _dirty = true，下一次get 的时候就可以执行 effect.run() 获取到最新值了；
*
*/
export class ComputedRefImpl<T> {
  public dep?: Dep = undefined

  private _value!: T
  public readonly effect: ReactiveEffect<T>

  public readonly __v_isRef = true
  public readonly [ReactiveFlags.IS_READONLY]: boolean = false

  public _dirty = true
  public _cacheable: boolean

  constructor(
    getter: ComputedGetter<T>,
    private readonly _setter: ComputedSetter<T>,
    isReadonly: boolean,
    isSSR: boolean
  ) {
    this.effect = new ReactiveEffect(getter, () => {
      // scheduler 的配置；_dirty 用来进行数据的缓存
      // 设置值的时候，_dirty 设为 true，下次获取的时候在执行一次副作用函数
      if (!this._dirty) {
        this._dirty = true
        triggerRefValue(this)
      }
    })
    this.effect.computed = this
    this.effect.active = this._cacheable = !isSSR
    this[ReactiveFlags.IS_READONLY] = isReadonly
  }

  // 获取计算属性值的时候
  get value() {
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    const self = toRaw(this)
    trackRefValue(self)
    // 如果是脏数据，需要更新，执行副作用函数，并设置 dirty = false，下次直接走缓存
    if (self._dirty || !self._cacheable) {
      self._dirty = false
      self._value = self.effect.run()!
    }
    return self._value
  }

  set value(newValue: T) {
    this._setter(newValue)
  }
}

/*
 * computed 跟 ref 很像，调用的时候也要 .value；
 * computed 的用法一般有两种：
 * 1. 传入一个 getter 函数； computed(() => count.value + 1)；不能 set
 * 2. 传入一个具有 get 和 set 函数的对象
 * computed({
 *   get: () => count.value + 1,
 *   set: val => {
 *     count.value = val - 1
 *   }
 * })
 */
export function computed<T>(
  getter: ComputedGetter<T>,
  debugOptions?: DebuggerOptions
): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions
): WritableComputedRef<T>
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions,
  isSSR = false
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  // getter 函数 ，set 报错
  const onlyGetter = isFunction(getterOrOptions)
  if (onlyGetter) {
    getter = getterOrOptions
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else {
    // 具有 get 和 set 的对象
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  const cRef = new ComputedRefImpl(getter, setter, onlyGetter || !setter, isSSR)

  if (__DEV__ && debugOptions && !isSSR) {
    cRef.effect.onTrack = debugOptions.onTrack
    cRef.effect.onTrigger = debugOptions.onTrigger
  }

  return cRef as any
}
