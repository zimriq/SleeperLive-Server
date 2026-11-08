// Keep routine events on stdout and failures on stderr, one JSON record per line.
export function logInfo(...parts) {
  console.log(JSON.stringify({level:'info',message:parts.join(' ')}));
}
export function logError(event,error) {
  // Error messages can contain parsed request bodies or upstream credentials.
  // Retain stack locations for diagnosis without logging messages or request data.
  const header=error instanceof Error ? `${error.name}: ${error.message}` : '';
  const stack=header && error.stack?.startsWith(header)
    ? error.stack.slice(header.length).split('\n').filter(line=>/^\s+at /.test(line)).join('\n') : '';
  console.error(JSON.stringify({level:'error',event,stack}));
}
