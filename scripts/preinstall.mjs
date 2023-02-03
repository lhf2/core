if (!/pnpm/.test(process.env.npm_execpath || '')) {
  // 使用 pnpm 代替 npm 命令
  // pnpm install 安装包
  console.warn(
    `\u001b[33mThis repository requires using pnpm as the package manager ` +
      ` for scripts to work properly.\u001b[39m\n`
  )
  process.exit(1)
}
