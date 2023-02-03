import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly,
  isShallow
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*#__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

// 缓存
const get = /*#__PURE__*/ createGetter()
const shallowGet = /*#__PURE__*/ createGetter(false, true)
const readonlyGet = /*#__PURE__*/ createGetter(true)
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values

  /**
   * const obj = {}
   * const proxy = reactive([obj])
   * console.log(proxy.includes(obj)) // false
   产生原因】proxy.includes() 会触发 get 捕获器并为 obj 生成对应代理对象并返回，
   而 includes 方法的参数传递的是 原始数据，
   相当于此时是 响应式对象 和 原始数据对象 进行比较，因此对应的结果一定是为 false
   */
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 外部调用上述方法，默认其内的 this 指向的是代理数组对象，
      // 但实际上是需要通过原始数组中进行遍历查找
      const arr = toRaw(this) as any
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      
      const res = arr[key](...args)

      // 如果目标数组所包含的元素中含有已经被代理过的元素
      // 而此时用户肯定会直接arrTarget.includes(item)
      // 而不是arrTarget.includes(proxyItem)
      // 故而我们需要将其原始值取出来，然后再执行一次includes才能获得正确的结果
      if (res === -1 || res === false) {
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 既会读取数组的 length 属性，也会设置数组的 length 属性，会造成栈溢出；
      // 需要屏蔽对 length 属性的读取，避免与副作用函数产生联系
      // 暂停 track 间接的设置 shouldTrack = false
      // 在 track 的时候会进行判断
      pauseTracking()
      // 执行函数
      const res = (toRaw(this) as any)[key].apply(this, args)
      // 重新 track
      resetTracking()
      return res
    }
  })
  return instrumentations
}

function hasOwnProperty(this: object, key: string) {
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key)
}

function createGetter(isReadonly = false, shallow = false) {
  return function get(target: Target, key: string | symbol, receiver: object) {
    // 实现 isReactive、isReadonly 功能
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return shallow
    } else if (
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
          ? shallowReactiveMap
          : reactiveMap
        ).get(target)
    ) {
      return target
    }

    // target 是否是数组
    const targetIsArray = isArray(target)

    if (!isReadonly) {
      // 重写数组的方法
      if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
        return Reflect.get(arrayInstrumentations, key, receiver)
      }
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }

    // 核心
    const res = Reflect.get(target, key, receiver)

    // 如果key是Symbol类型，
    // 判断Object.getOwnPropertyNames里面是不是有这个Symbol类型的key; for..of迭代器的时候；如果有直接返回res; 
    // 如果不是Symbol类型，看看是不是不需要track的key，如果是，直接返回；
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    if (!isReadonly) {
      // 进行依赖收集
      track(target, TrackOpTypes.GET, key)
    }

    // 如果是表层的 直接返回 res
    if (shallow) {
      return res
    }

    // 如果 res 是 ref
    if (isRef(res)) {
      // 展开直接返回 res.value
      // ref unwrapping - skip unwrap for Array + integer key.
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    // 嵌套对象的情况 要把每一层对象都变成响应式
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

/*
   核心：
   1. Reflect.set
   2. trigger 触发依赖更新 ADD/SET
*/
function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    let oldValue = (target as any)[key]
    if (isReadonly(oldValue) && isRef(oldValue) && !isRef(value)) {
      return false
    }
    if (!shallow) {
      if (!isShallow(value) && !isReadonly(value)) {
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    // 如果是数组，设置的索引在数组长度之内 SET，如果在数组长度之外 ADD
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    
    // 核心
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    // 原型继承问题
    // 只有当 receiver 是 target 的代理对象时才触发更新，这样就能屏蔽由原型引起的更新；
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        // 如果 target 里面没有 key，触发依赖的类型是 ADD(新增)
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        // 如果 target 里面有 key，并且值都不同了，触发依赖的类型是 SET(设置)
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

/*
   核心：
   1. Reflect.deleteProperty
   2. trigger 触发依赖更新 DELETE
 */
function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  // 核心
  const result = Reflect.deleteProperty(target, key)
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}


/*
   核心：
   1. Reflect.has
   2. track 收集依赖 HAS
 */
function has(target: object, key: string | symbol): boolean {
  // 核心
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

// for..in
function ownKeys(target: object): (string | symbol)[] {
  // 因为没有具体操作的 key，使用 ITERATE_KEY 作为追踪的 key
  // 如果是数组的话，使用 length 来作为追踪的 key，
  // 因为一旦数组的 length 属性被修改，那么 for...in 循环对数组的遍历结果就会改变;
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}

/*
 * readonly：只读的，set delete 的时候报错；
 * 因为不能 set，所以也没必要在 get 的时候 track
 */
export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
